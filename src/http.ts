// The vault's HTTP surface. One process, four jobs:
//   /v1/exec        agents (bearer session token)         /v1/owner/exec   the owner (bearer owner token)
//   /mcp            MCP over Streamable HTTP for claude.ai connectors (bearer session token, or /mcp/<token>)
//   /pay/:id        invoice pay page + Solana Pay transaction request, for any wallet, human or agent
//   /               owner console: pairings, approvals, backend switch, policy
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { address, appendTransactionMessageInstructions, compileTransaction, createNoopSigner, createTransactionMessage, getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, AccountRole } from "@solana/kit";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { getAddMemoInstruction } from "@solana-program/memo";
import "./commands/index.js";
import { exec, get as getCommand } from "./core/registry.js";
import { createCtx } from "./core/ctx.js";
import { toWalletError, WalletError } from "./core/errors.js";
import { home } from "./core/config.js";
import { hash } from "./core/session.js";
import { invoices, invoiceView, refreshInvoice } from "./core/invoice.js";
import { solanaPayUrl, toBaseUnits, USDC_MINT } from "./core/pay.js";
import { createMcpServer } from "./mcp.js";
import { ownerConsoleHtml, payPageHtml } from "./pages.js";

export function ownerTokenHash(): string {
  if (process.env.SAW_OWNER_TOKEN) return hash(process.env.SAW_OWNER_TOKEN);
  const f = join(home(), "owner-token");
  if (!existsSync(f)) {
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    writeFileSync(f, randomBytes(24).toString("hex"), { mode: 0o600 });
  }
  return hash(readFileSync(f, "utf8").trim());
}

export function ownerTokenFile(): string {
  return join(home(), "owner-token");
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

function isOwner(token: string | null): boolean {
  if (!token) return false;
  const a = Buffer.from(hash(token));
  const b = Buffer.from(ownerTokenHash());
  return a.length === b.length && timingSafeEqual(a, b);
}

async function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, v: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" });
  res.end(JSON.stringify(v));
}

function html(res: ServerResponse, status: number, s: string): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(s);
}

export interface VaultOptions {
  publicUrl: string;
}

export function createHandler(opts: VaultOptions) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    try {
      if (req.method === "OPTIONS") return json(res, 204, {});

      if (path === "/v1/exec" && req.method === "POST") {
        const { command, params } = JSON.parse((await body(req)) || "{}") as { command: string; params?: Record<string, unknown> };
        const cmd = getCommand(command);
        if (!cmd) throw new WalletError("UNKNOWN_COMMAND", `Unknown command ${command}`);
        if (cmd.cli.startsWith("owner")) throw new WalletError("OWNER_REQUIRED", "Owner commands are not reachable with an agent token. Use the owner console.");
        const ctx = createCtx({ role: "agent", token: bearer(req), vaultUrl: opts.publicUrl });
        return json(res, 200, { success: true, data: await exec(ctx, command, params ?? {}) });
      }

      if (path === "/v1/owner/exec" && req.method === "POST") {
        if (!isOwner(bearer(req))) return json(res, 401, { success: false, error: new WalletError("OWNER_REQUIRED", "Invalid owner token.").toJSON() });
        const { command, params } = JSON.parse((await body(req)) || "{}") as { command: string; params?: Record<string, unknown> };
        const ctx = createCtx({ role: "owner", vaultUrl: opts.publicUrl });
        return json(res, 200, { success: true, data: await exec(ctx, command, params ?? {}) });
      }

      if (path === "/mcp" || path.startsWith("/mcp/")) {
        const token = bearer(req) ?? (path.length > 5 ? decodeURIComponent(path.slice(5)) : null);
        const server = createMcpServer({ roles: ["agent"], token: () => token, vaultUrl: opts.publicUrl });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => void transport.close());
        await server.connect(transport);
        return transport.handleRequest(req, res);
      }

      if (path === "/" || path === "/console") return html(res, 200, ownerConsoleHtml(opts.publicUrl));
      if (path === "/pair") return html(res, 200, ownerConsoleHtml(opts.publicUrl, url.searchParams.get("code") ?? ""));

      const pay = /^\/pay\/([A-Za-z0-9_]+)(\/status|\/tx)?$/.exec(path);
      if (pay) {
        const id = pay[1];
        const inv = invoices.get(id);
        if (!inv) return json(res, 404, { success: false, error: new WalletError("TARGET_NOT_FOUND", `No invoice ${id}`).toJSON() });
        const sub = pay[2];
        const ctx = createCtx({ role: "owner" });
        if (sub === "/status") return json(res, 200, { success: true, data: invoiceView(await refreshInvoice(ctx, id)) });
        if (sub === "/tx" && req.method === "GET") return json(res, 200, { label: `Invoice ${id}: ${inv.memo}`, icon: `${opts.publicUrl}/icon.svg` });
        if (sub === "/tx" && req.method === "POST") {
          const { account } = JSON.parse((await body(req)) || "{}") as { account?: string };
          if (!account) return json(res, 400, { error: "account required" });
          const payer = address(account);
          const mint = address(USDC_MINT[inv.cluster]);
          const recipient = address(inv.recipient);
          const [src] = await findAssociatedTokenPda({ mint, owner: payer, tokenProgram: TOKEN_PROGRAM_ADDRESS });
          const [dst] = await findAssociatedTokenPda({ mint, owner: recipient, tokenProgram: TOKEN_PROGRAM_ADDRESS });
          const signer = createNoopSigner(payer);
          const transfer = getTransferCheckedInstruction({ source: src, mint, destination: dst, authority: signer, amount: toBaseUnits(inv.amount), decimals: 6 });
          const { value: bh } = await ctx.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
          const msg = pipe(
            createTransactionMessage({ version: 0 }),
            (m) => setTransactionMessageFeePayer(payer, m),
            (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
            (m) =>
              appendTransactionMessageInstructions(
                [
                  getCreateAssociatedTokenIdempotentInstruction({ payer: signer, owner: recipient, mint, ata: dst }),
                  { ...transfer, accounts: [...transfer.accounts, { address: address(inv.reference), role: AccountRole.READONLY }] },
                  getAddMemoInstruction({ memo: `${inv.id} ${inv.memo}`.slice(0, 200) }),
                ],
                m,
              ),
          );
          return json(res, 200, { transaction: getBase64EncodedWireTransaction(compileTransaction(msg)), message: `Pay invoice ${inv.id}: ${inv.amount} USDC for ${inv.memo}` });
        }
        if (req.headers.accept?.includes("application/json")) return json(res, 200, { success: true, data: invoiceView(inv) });
        return html(res, 200, await payPageHtml(invoiceView(inv), solanaPayUrl(inv), `solana:${opts.publicUrl}/pay/${id}/tx`));
      }

      if (path === "/icon.svg") {
        res.writeHead(200, { "content-type": "image/svg+xml" });
        res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#0f8a5f"/><text x="32" y="42" font-size="28" text-anchor="middle" fill="#fff" font-family="sans-serif">S</text></svg>');
        return;
      }

      json(res, 404, { success: false, error: { code: 404, name: "NOT_FOUND", message: "no such route" } });
    } catch (e) {
      const err = toWalletError(e);
      if (!res.headersSent) json(res, err.name === "NOT_SIGNED_IN" || err.name === "SESSION_EXPIRED" ? 401 : 400, { success: false, error: err.toJSON() });
    }
  };
}
