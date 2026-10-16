// Exercises a running vault over HTTP: pairing, owner approval, MCP tools.
//   SAW_OWNER_TOKEN=... node scripts/http-smoke.mjs http://localhost:3000
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/$/, "");
const owner = process.env.SAW_OWNER_TOKEN;
const post = async (path, body, token) => (await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })).json();
const s = await post("/v1/exec", { command: "auth.signin", params: { label: "http-smoke" } });
console.log("pairing code", s.data.pairingCode, "approve at", s.data.urlForWeb);
if (owner) console.log("owner approve:", (await post("/v1/owner/exec", { command: "owner.approve-pairing", params: { pairingCode: s.data.pairingCode } }, owner)).data);
const v = await post("/v1/exec", { command: "auth.verify", params: { qrCodeId: s.data.qrCodeId } });
if (!v.success) throw new Error(v.error.message);
const c = new Client({ name: "smoke", version: "0" });
await c.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${v.data.token}` } } }));
console.log((await c.listTools()).tools.length, "tools over MCP");
console.log((await c.callTool({ name: "wallet_status", arguments: {} })).content[0].text);
await c.close();
