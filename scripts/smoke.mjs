// Drives the stdio MCP server end to end (local mode, no network needed for these calls).
//   SMOKE_HOME=$(mktemp -d) node scripts/smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const home = process.env.SMOKE_HOME ?? `/tmp/saw-smoke-${process.pid}`;
const t = new StdioClientTransport({ command: "npx", args: ["tsx", "src/index.ts"], env: { ...process.env, SOLANA_CLUSTER: "devnet", SAW_HOME: home } });
const c = new Client({ name: "smoke", version: "0" });
await c.connect(t);
const tools = (await c.listTools()).tools.map((x) => x.name);
console.log(`${tools.length} tools, e.g.`, tools.slice(0, 8).join(", "), "…");
const text = (r) => r.content[0].text;
console.log(text(await c.callTool({ name: "owner_keygen", arguments: {} })).split("\n")[1]);
console.log(text(await c.callTool({ name: "wallet_status", arguments: {} })));
const inv = await c.callTool({ name: "create_invoice", arguments: { amount: "1.5", memo: "smoke test" } });
console.log("invoice:", inv.structuredContent.id, inv.structuredContent.url.slice(0, 60) + "…");
const dry = await c.callTool({ name: "send_payment", arguments: { to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", amount: "0.25", memo: "coffee", confirm: false } });
console.log("send (expect address-book error):", text(dry).split("\n")[0]);
console.log(text(await c.callTool({ name: "owner_add_contact", arguments: { name: "kevin", address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" } })));
console.log(text(await c.callTool({ name: "wallet_settings", arguments: {} })).slice(0, 120) + "…");
await c.close();
