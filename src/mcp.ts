// MCP surface: one tool per registry command (dots → underscores), plus the original solana-pay-mcp tool names
// as aliases so existing Claude configs keep working. Cards (MCP Apps) render sends, batches, invoices,
// balances, status and pending approvals.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { z } from "zod";
import "./commands/index.js";
import { commands, exec, type Command } from "./core/registry.js";
import { createCtx, type Role } from "./core/ctx.js";
import { toWalletError } from "./core/errors.js";
import { localSession, approvePairing, startPairing, pollPairing } from "./core/session.js";
import { readPolicy } from "./core/policy.js";
import { walletHtml } from "./ui.js";
import { CLI_VERSION } from "./core/config.js";

const UI = "ui://solana-pay/wallet.html";
const VIEWS: Record<string, string> = {
  "wallet.send": "send", "wallet.pay-many": "batch", "wallet.balance": "balance", "wallet.status": "status", "wallet.settings": "status",
  "invoice.create": "invoice", "invoice.status": "invoice", "owner.pending": "pending", "owner.approve": "send", "owner.backends": "status",
  "owner.fleet-list": "fleet", "owner.fleet-pause": "fleet", "owner.fleet-resume": "fleet", "owner.fleet-kill": "fleet",
};
const ALIASES: Record<string, { to: string; map?: (a: Record<string, unknown>) => Record<string, unknown> }> = {
  create_invoice: { to: "invoice.create" },
  check_payment: { to: "invoice.status" },
  list_requests: { to: "invoice.list" },
  send_payment: { to: "wallet.send", map: (a) => ({ recipient: a.to, amount: a.amount, tokenAddress: a.token ?? "USDC", memo: a.memo, dryRun: a.confirm === true ? undefined : a.confirm === false ? true : undefined }) },
  pay_many: { to: "wallet.pay-many", map: (a) => ({ payments: a.payments, tokenAddress: a.token, dryRun: a.confirm ? undefined : true }) },
  list_contacts: { to: "wallet.contacts" },
};

export interface McpOptions {
  /** Which commands this server exposes: agent-only (remote connectors) or agent + owner (local stdio). */
  roles: Role[];
  token: () => string | null;
  vaultUrl?: string;
  /** Remote mode: run commands on a vault instead of in-process. */
  remote?: (name: string, params: Record<string, unknown>) => Promise<unknown>;
}

async function runCommand(o: McpOptions, cmd: Command, params: Record<string, unknown>) {
  if (o.remote && !cmd.cli.startsWith("owner")) return o.remote(cmd.name, params);
  const role: Role = cmd.cli.startsWith("owner") ? "owner" : "agent";
  return exec(createCtx({ role, token: o.token(), vaultUrl: o.vaultUrl }), cmd.name, params);
}

export function createMcpServer(o: McpOptions): McpServer {
  const server = new McpServer({ name: "solana-pay-mcp", version: CLI_VERSION });
  registerAppResource(server, "Solana agentic wallet", UI, { mimeType: RESOURCE_MIME_TYPE }, async () => ({ contents: [{ uri: UI, mimeType: RESOURCE_MIME_TYPE, text: walletHtml() }] }));

  const toolFor = (cmd: Command, name: string, map?: (a: Record<string, unknown>) => Record<string, unknown>, extraSchema?: z.ZodRawShape) => {
    const schema: z.ZodRawShape = extraSchema ?? { ...cmd.params, ...(cmd.loose ? { extra: z.record(z.string(), z.unknown()).optional().describe("Additional flags passed through to the backend") } : {}) };
    const view = VIEWS[cmd.name];
    const config = { title: cmd.title, description: cmd.description + (cmd.write ? " (State-changing: confirm with the user first.)" : ""), inputSchema: schema, ...(view ? { _meta: { ui: { resourceUri: UI } } } : {}) };
    const handler = async (args: Record<string, unknown>) => {
      const raw = map ? map(args) : args;
      const { extra, ...rest } = raw as { extra?: Record<string, unknown> };
      const params = { ...rest, ...(extra ?? {}) };
      try {
        const data = await runCommand(o, cmd, params);
        const sc = view && data && typeof data === "object" && !Array.isArray(data) ? { view, tool: name, ...(data as Record<string, unknown>) } : view ? { view, tool: name, rows: data } : undefined;
        return { content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }], ...(sc ? { structuredContent: sc } : {}) };
      } catch (e) {
        const err = toWalletError(e);
        return { content: [{ type: "text" as const, text: `${err.name} (${err.code}): ${err.message}${err.data !== undefined ? "\n" + JSON.stringify(err.data) : ""}` }], isError: true };
      }
    };
    if (view) registerAppTool(server, name, config as never, handler as never);
    else server.registerTool(name, config as never, handler as never);
  };

  for (const cmd of commands()) {
    if (cmd.cli.startsWith("owner") && !o.roles.includes("owner")) continue;
    toolFor(cmd, cmd.name.replace(/[.-]/g, "_"));
  }
  for (const [alias, a] of Object.entries(ALIASES)) {
    const cmd = commands().find((c) => c.name === a.to)!;
    const legacy: z.ZodRawShape =
      alias === "send_payment"
        ? { to: z.string(), amount: z.string(), token: z.string().optional(), memo: z.string().optional(), confirm: z.boolean().optional() }
        : alias === "pay_many"
          ? { payments: z.array(z.object({ to: z.string(), amount: z.string(), memo: z.string().optional() })), token: z.string().optional(), confirm: z.boolean().optional() }
          : cmd.params;
    toolFor(cmd, alias, a.map, legacy);
  }
  return server;
}

/** Local stdio (Claude Code / Claude Desktop). The process is both owner console and agent; it signs itself in. */
export async function startStdio(): Promise<void> {
  const vaultUrl = process.env.SAW_VAULT_URL ?? localSession.read().vaultUrl ?? undefined;
  let token = localSession.read().token;
  if (!vaultUrl && !token && !readPolicy().requirePairingApproval) {
    const p = startPairing("mcp stdio");
    approvePairing(p.pairingCode);
    token = pollPairing(p.id).token ?? null;
    localSession.write({ token, vaultUrl: null });
  }
  const remote = vaultUrl ? async (name: string, params: Record<string, unknown>) => (await import("./remote.js")).remoteExec(vaultUrl, localSession.read().token, name, params) : undefined;
  const server = createMcpServer({ roles: vaultUrl ? ["agent"] : ["agent", "owner"], token: () => localSession.read().token ?? token, vaultUrl, remote });
  await server.connect(new StdioServerTransport());
}
