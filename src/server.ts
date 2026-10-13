// All MCP tools. Transport-agnostic: index.ts wires stdio or HTTP.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import QRCode from "qrcode";
import { randomUUID } from "node:crypto";
import { type PaymentRequest, type Token, DECIMALS, fromBaseUnits, solanaPayUrl, toBaseUnits } from "./pay.js";
import * as store from "./store.js";
import * as contacts from "./contacts.js";
import { balances, cluster, explorerUrl, findPayment, newReference, recipient } from "./solana.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { walletHtml } from "./ui.js";
import { dailyCapUnits, execute, signerAddress, signerPath, spentLast24h } from "./signer.js";

const amountSchema = z
  .string()
  .describe('Amount as a decimal string, e.g. "3000" or "12.50"')
  .refine((a) => {
    try {
      return toBaseUnits(a, 9) > 0n;
    } catch {
      return false;
    }
  }, "amount must be a positive decimal with at most 9 decimals");

const tokenSchema = z.enum(["USDC", "SOL"]).optional().describe("USDC (default) or SOL");

const UI = "ui://solana-pay/wallet.html";
const ui = { ui: { resourceUri: UI } };
const qrSvg = (text: string) => QRCode.toString(text, { type: "svg", margin: 1 });

async function present(req: PaymentRequest, verb: string) {
  const url = solanaPayUrl(req);
  const qr = await QRCode.toString(url, { type: "terminal", small: true });
  return {
    content: [
      {
        type: "text" as const,
        text: [
          `${verb} ${req.amount} USDC on ${req.cluster} (id ${req.id})`,
          `To: ${req.recipient}`,
          `Memo: ${req.memo}`,
          `Pay link (open in Phantom/Solflare/Backpack): ${url}`,
          "",
          qr,
          `Then run check_payment with id ${req.id}.`,
        ].join("\n"),
      },
    ],
    structuredContent: { ...req, url, view: "invoice", qrSvg: await qrSvg(url) },
  };
}

async function newPayment(to: string, amount: string, memo: string, token: Token): Promise<PaymentRequest> {
  toBaseUnits(amount, DECIMALS[token]); // reject too many decimals for this token
  return {
    id: `pay_${randomUUID().slice(0, 8)}`,
    kind: "payment",
    recipient: contacts.resolve(to),
    amount,
    token,
    memo,
    reference: await newReference(),
    cluster: cluster(),
    createdAt: new Date().toISOString(),
  };
}

function markSent(req: PaymentRequest, tx: string) {
  req.paidTx = tx;
  req.paidAt = new Date().toISOString();
  req.matchedBy = "signer";
  store.put(req);
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "solana-pay-mcp", version: "0.3.0" });

  // MCP Apps: one HTML view renders previews (with a Pay button), receipts, invoices and the wallet card.
  registerAppResource(server, "Solana Pay wallet", UI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({
    contents: [{ uri: UI, mimeType: RESOURCE_MIME_TYPE, text: walletHtml() }],
  }));

  registerAppTool(
    server,
    "create_invoice",
    {
      _meta: ui,
      title: "Create USDC invoice",
      description:
        "Create an invoice your client pays in USDC on Solana. Returns a Solana Pay link and QR. " +
        "Money goes straight to SOLANA_PAY_RECIPIENT (your wallet). Follow with check_payment.",
      inputSchema: { amount: amountSchema, memo: z.string().min(1).max(120).describe("What it is for") },
    },
    async ({ amount, memo }) => {
      toBaseUnits(amount); // USDC: max 6 decimals
      const req: PaymentRequest = {
        id: `inv_${randomUUID().slice(0, 8)}`,
        kind: "invoice",
        recipient: recipient(),
        amount,
        memo,
        reference: await newReference(),
        cluster: cluster(),
        createdAt: new Date().toISOString(),
      };
      store.put(req);
      return present(req, "Invoice for");
    },
  );

  registerAppTool(
    server,
    "send_payment",
    {
      _meta: ui,
      title: "Pay someone",
      description:
        "Pay a contact or address in USDC or SOL on Solana. " +
        "With an agent signer configured (SOLANA_PAY_SIGNER), call once to get a preview, then call again with " +
        "confirm=true to sign and send within the daily cap. Without a signer, returns a Solana Pay link/QR you approve in your own wallet.",
      inputSchema: {
        to: z.string().describe("Saved contact name (e.g. 'kevin') or a Solana wallet address"),
        amount: amountSchema,
        token: tokenSchema,
        memo: z.string().min(1).max(120).describe("What it is for"),
        confirm: z.boolean().optional().describe("Set true to actually sign and send from the agent wallet"),
      },
    },
    async ({ to, amount, token = "USDC", memo, confirm }) => {
      const req = await newPayment(to, amount, memo, token);
      if (!signerPath()) {
        if (token === "SOL") throw new Error("SOL payments need an agent signer. Run `solana-pay-mcp keygen`.");
        store.put(req);
        return present(req, "Payment of");
      }
      const dec = DECIMALS[token];
      const from = await signerAddress();
      const cap = fromBaseUnits(dailyCapUnits(token), dec);
      const spent = fromBaseUnits(spentLast24h(token), dec);
      if (!confirm) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                `PREVIEW, nothing sent.`,
                `Pay ${amount} ${token} to ${to} (${req.recipient}) on ${req.cluster}`,
                `From agent wallet ${from}`,
                `Memo: ${memo}`,
                `Daily cap ${cap} ${token}, spent ${spent} in last 24h.`,
                `Call send_payment again with the same arguments and confirm=true to send.`,
              ].join("\n"),
            },
          ],
          structuredContent: {
            ...req, from, cap, spent, token, toLabel: to, preview: true, view: "preview",
            args: { to, amount, token, memo },
          },
        };
      }
      store.put(req);
      const done = await execute(req);
      markSent(req, done.tx);
      return {
        content: [
          {
            type: "text" as const,
            text: `SENT. ${amount} ${token} to ${to} from ${done.from}. Remaining daily cap ${done.remainingCap} ${token}.\n${explorerUrl(done.tx)}`,
          },
        ],
        structuredContent: {
          ...req, from: done.from, remainingCap: done.remainingCap, token, toLabel: to, view: "sent", explorer: explorerUrl(done.tx),
        },
      };
    },
  );

  registerAppTool(
    server,
    "pay_many",
    {
      _meta: ui,
      title: "Pay several people",
      description:
        "Batch payments from the agent wallet: payroll, bounties, splits. Each item is a contact name or address plus amount. " +
        "Call once for a preview (total vs daily cap), then again with confirm=true to send. One transaction per recipient.",
      inputSchema: {
        payments: z
          .array(z.object({ to: z.string(), amount: amountSchema, memo: z.string().min(1).max(120) }))
          .min(1)
          .max(200),
        token: tokenSchema,
        confirm: z.boolean().optional(),
      },
    },
    async ({ payments, token = "USDC", confirm }) => {
      if (!signerPath()) throw new Error("pay_many needs an agent signer. Run `solana-pay-mcp keygen` and set SOLANA_PAY_SIGNER.");
      const dec = DECIMALS[token];
      const reqs: PaymentRequest[] = [];
      for (const p of payments) reqs.push(await newPayment(p.to, p.amount, p.memo, token));
      const total = reqs.reduce((a, r) => a + toBaseUnits(r.amount, dec), 0n);
      const left = dailyCapUnits(token) - spentLast24h(token);
      const rows = payments.map((p, i) => `${p.amount} ${token} → ${p.to} (${reqs[i].recipient.slice(0, 6)}…) ${p.memo}`);
      const base = (status: (string | undefined)[] = [], explorers: (string | undefined)[] = []) =>
        payments.map((p, i) => ({ to: p.to, recipient: reqs[i].recipient, amount: p.amount, memo: p.memo, status: status[i], explorer: explorers[i] }));
      if (!confirm) {
        const over = total > left ? `\nOVER CAP: only ${fromBaseUnits(left, dec)} ${token} left today.` : "";
        return {
          content: [
            {
              type: "text" as const,
              text: `PREVIEW, nothing sent.\n${rows.join("\n")}\nTotal ${fromBaseUnits(total, dec)} ${token}, ${fromBaseUnits(left, dec)} ${token} left in daily cap.${over}\nCall again with confirm=true to send.`,
            },
          ],
          structuredContent: {
            view: "batch_preview", token, rows: base(), total: fromBaseUnits(total, dec), left: fromBaseUnits(left, dec),
            overCap: total > left, args: { payments, token },
          },
        };
      }
      // ponytail: sequential, one tx each; batch several transfers per tx if payroll > ~50 rows gets slow.
      const out: string[] = [];
      const status: string[] = [];
      const explorers: (string | undefined)[] = [];
      for (const req of reqs) {
        store.put(req);
        try {
          const done = await execute(req);
          markSent(req, done.tx);
          out.push(`SENT ${req.amount} ${token} → ${req.recipient.slice(0, 6)}… ${explorerUrl(done.tx)}`);
          status.push("sent");
          explorers.push(explorerUrl(done.tx));
        } catch (e) {
          out.push(`FAILED ${req.amount} ${token} → ${req.recipient.slice(0, 6)}…: ${(e as Error).message}`);
          status.push(`failed: ${(e as Error).message}`);
          explorers.push(undefined);
          break; // stop on first failure (cap, no funds); nothing after it is attempted
        }
      }
      return {
        content: [{ type: "text" as const, text: out.join("\n") }],
        structuredContent: { view: "batch_sent", token, rows: base(status, explorers), total: fromBaseUnits(total, dec) },
      };
    },
  );

  server.registerTool(
    "add_contact",
    {
      title: "Save a contact",
      description: "Save a name for a wallet address so you can say 'pay kevin 5 USDC'.",
      inputSchema: { name: z.string().min(1).max(40), address: z.string() },
    },
    async ({ name, address: addr }) => {
      contacts.save(name, addr);
      return { content: [{ type: "text" as const, text: `Saved ${name.toLowerCase()} → ${addr}` }] };
    },
  );

  server.registerTool(
    "list_contacts",
    { title: "List contacts", description: "Saved names and their wallet addresses." },
    async () => {
      const c = contacts.all();
      const text = Object.keys(c).length ? Object.entries(c).map(([n, a]) => `${n} → ${a}`).join("\n") : "No contacts yet.";
      return { content: [{ type: "text" as const, text }] };
    },
  );

  registerAppTool(
    server,
    "wallet_status",
    {
      _meta: ui, title: "Agent wallet status", description: "Agent wallet card: balances, daily caps, and the address/QR to fund it. Use for 'fund my wallet' or 'what is my balance'." },
    async () => {
      const lines = [`Cluster: ${cluster()}`, `Invoices paid to: ${recipient()}`];
      let sc: Record<string, unknown> = { view: "status", cluster: cluster(), signer: null };
      if (signerPath()) {
        const addr = await signerAddress();
        const b = await balances(addr);
        lines.push(`Agent signer: ${addr}`);
        lines.push(`Balance: ${b.usdc} USDC, ${b.sol} SOL`);
        sc = {
          ...sc, signer: addr, usdc: b.usdc, sol: b.sol, qrSvg: await qrSvg(addr),
          capUsdc: fromBaseUnits(dailyCapUnits()), spentUsdc: fromBaseUnits(spentLast24h()),
          capSol: fromBaseUnits(dailyCapUnits("SOL"), 9), spentSol: fromBaseUnits(spentLast24h("SOL"), 9),
        };
        lines.push(`Daily cap: ${fromBaseUnits(dailyCapUnits())} USDC, spent last 24h: ${fromBaseUnits(spentLast24h())} USDC`);
        lines.push(`Daily cap: ${fromBaseUnits(dailyCapUnits("SOL"), 9)} SOL, spent last 24h: ${fromBaseUnits(spentLast24h("SOL"), 9)} SOL`);
      } else {
        lines.push("Agent signer: none. Payments return a QR for your own wallet. Run `solana-pay-mcp keygen` to enable.");
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }], structuredContent: sc };
    },
  );

  server.registerTool(
    "check_payment",
    {
      title: "Check if an invoice or payment settled",
      description: "Look on-chain for a USDC transfer matching the request. Works for invoices and payments.",
      inputSchema: { id: z.string().describe("Invoice or payment id, e.g. inv_1a2b3c4d") },
    },
    async ({ id }) => {
      const req = store.get(id);
      if (!req) return { content: [{ type: "text" as const, text: `No request with id ${id}.` }], isError: true };
      if (!req.paidTx) {
        const found = await findPayment(req);
        if (found) {
          req.matchedBy = found.matchedBy;
          req.paidTx = found.tx;
          req.paidAt = found.blockTime ? new Date(found.blockTime * 1000).toISOString() : new Date().toISOString();
          store.put(req);
        }
      }
      const token = req.token ?? "USDC";
      const text = req.paidTx
        ? `PAID. ${req.amount} ${token} to ${req.recipient} at ${req.paidAt}` +
          (req.matchedBy === "inflow" ? " (matched by inflow: the wallet dropped the reference key)" : "") +
          `.\n${explorerUrl(req.paidTx)}`
        : `UNPAID. No ${token} transfer of ${req.amount} to ${req.recipient} found yet (reference ${req.reference}).`;
      return { content: [{ type: "text" as const, text }], structuredContent: { ...req, paid: Boolean(req.paidTx) } };
    },
  );

  server.registerTool(
    "list_requests",
    { title: "List invoices and payments", description: "All requests this server created, newest last." },
    async () => {
      const rows = store.all();
      const text = rows.length
        ? rows
            .map((r) => `${r.id} ${r.kind} ${r.amount} ${r.token ?? "USDC"} → ${r.recipient.slice(0, 6)}… ${r.paidTx ? "PAID" : "unpaid"} ${r.memo}`)
            .join("\n")
        : "No requests yet.";
      return { content: [{ type: "text" as const, text }], structuredContent: { requests: rows } };
    },
  );

  return server;
}
