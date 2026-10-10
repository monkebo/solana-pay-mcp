import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const t = new StdioClientTransport({
  command: "npx", args: ["tsx", "src/index.ts"],
  env: { ...process.env, SOLANA_CLUSTER: "devnet", SOLANA_PAY_RECIPIENT: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", SOLANA_PAY_MCP_HOME: process.env.SMOKE_HOME },
});
const c = new Client({ name: "smoke", version: "0" });
await c.connect(t);
console.log("tools:", (await c.listTools()).tools.map(x => x.name).join(", "));
const inv = await c.callTool({ name: "create_invoice", arguments: { amount: "1.5", memo: "smoke test" } });
console.log(inv.content[0].text.split("\n").slice(0, 4).join("\n"));
const id = inv.structuredContent.id;
const chk = await c.callTool({ name: "check_payment", arguments: { id } });
console.log(chk.content[0].text);
const pay = await c.callTool({ name: "send_payment", arguments: { to: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", amount: "0.25", memo: "coffee" } });
console.log(pay.content[0].text.split("\n")[0]);
const ls = await c.callTool({ name: "list_requests", arguments: {} });
console.log(ls.content[0].text);
const bad = await c.callTool({ name: "create_invoice", arguments: { amount: "1.1234567", memo: "x" } }).catch(e => ({ content: [{ text: "rejected: " + e.message.slice(0, 80) }] }));
console.log(bad.content?.[0]?.text ?? JSON.stringify(bad).slice(0, 120));
await c.close();
