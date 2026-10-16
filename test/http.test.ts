import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

process.env.SAW_HOME = mkdtempSync(join(tmpdir(), "saw-"));
process.env.SOLANA_CLUSTER = "devnet";
process.env.SAW_OWNER_TOKEN = "owner-secret-token";

// A fake Solana JSON-RPC node for the few calls the pay page needs.
const rpcServer = createServer(async (req, res) => {
  let s = "";
  for await (const c of req) s += c;
  const { id, method } = JSON.parse(s);
  const result = method === "getLatestBlockhash" ? { context: { slot: 1 }, value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1000 } } : method === "getSignaturesForAddress" ? [] : null;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
});
await new Promise<void>((r) => rpcServer.listen(0, r));
process.env.SOLANA_RPC_URL = `http://127.0.0.1:${(rpcServer.address() as { port: number }).port}`;

const { createHandler } = await import("../src/http.js");
const { keygen } = await import("../src/core/signer.js");
const policy = await import("../src/core/policy.js");

let server: Server;
let base: string;
const post = async (path: string, bodyObj: unknown, token?: string) => {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(bodyObj) });
  return { status: r.status, body: await r.json() };
};

beforeAll(async () => {
  await keygen();
  policy.patchPolicy({ requirePairingApproval: "true" });
  server = createServer(createHandler({ publicUrl: "http://vault.test" }));
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => {
  server.close();
  rpcServer.close();
});

describe("vault HTTP", () => {
  let token: string;
  it("pairs an agent: signin → owner approves in the console → verify → session works", async () => {
    const s = await post("/v1/exec", { command: "auth.signin", params: { label: "phone" } });
    expect(s.body.data.urlForWeb).toBe(`http://vault.test/pair?code=${s.body.data.pairingCode}`);
    expect(s.body.data.autoApprove).toBe(false);
    // not yet approved: verify without waiting says pending
    const pend = await post("/v1/exec", { command: "auth.verify", params: { qrCodeId: s.body.data.qrCodeId, wait: false } });
    expect(pend.body.error.name).toBe("AUTH_PENDING");
    // wrong owner token
    expect((await post("/v1/owner/exec", { command: "owner.approve-pairing", params: { pairingCode: s.body.data.pairingCode } }, "nope")).status).toBe(401);
    const ap = await post("/v1/owner/exec", { command: "owner.approve-pairing", params: { pairingCode: s.body.data.pairingCode } }, "owner-secret-token");
    expect(ap.body.data.status).toBe("APPROVED");
    const v = await post("/v1/exec", { command: "auth.verify", params: { qrCodeId: s.body.data.qrCodeId } });
    token = v.body.data.token;
    expect(token).toHaveLength(64);
    const st = await post("/v1/exec", { command: "wallet.settings", params: {} }, token);
    expect(st.body.data.dailyLimit).toBe(100);
    // agents cannot reach owner commands even with a valid session
    const own = await post("/v1/exec", { command: "owner.policy", params: {} }, token);
    expect(own.body.error.name).toBe("OWNER_REQUIRED");
    const anon = await post("/v1/exec", { command: "wallet.settings", params: {} });
    expect(anon.status).toBe(401);
  });

  it("serves the owner console and the pay page with a transaction request", async () => {
    const page = await (await fetch(base + "/")).text();
    expect(page).toContain("Wallet owner console");
    const inv = await post("/v1/exec", { command: "invoice.create", params: { amount: "12.5", memo: "October retainer" } }, token);
    const id = inv.body.data.id as string;
    const pay = await (await fetch(`${base}/pay/${id}`)).text();
    expect(pay).toContain("12.5");
    expect(pay).toContain("October retainer");
    expect(pay).toContain("<svg");
    const meta = await (await fetch(`${base}/pay/${id}/tx`)).json();
    expect(meta.label).toContain(id);
    const tx = await (await fetch(`${base}/pay/${id}/tx`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" }) })).json();
    expect(typeof tx.transaction).toBe("string");
    expect(Buffer.from(tx.transaction, "base64").length).toBeGreaterThan(200);
    const status = await (await fetch(`${base}/pay/${id}/status`)).json();
    expect(status.data.status).toBe("UNPAID");
    const asJson = await (await fetch(`${base}/pay/${id}`, { headers: { accept: "application/json" } })).json();
    expect(asJson.data.id).toBe(id);
  });

  it("speaks MCP over HTTP with the session token and exposes agent tools only", async () => {
    const client = new Client({ name: "t", version: "0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("wallet_send");
    expect(tools).toContain("create_invoice");
    expect(tools).toContain("x402_payment_pay");
    expect(tools.some((t) => t.startsWith("owner_"))).toBe(false);
    const r = (await client.callTool({ name: "wallet_status", arguments: {} })) as { structuredContent: { status: string; backend: string } };
    expect(r.structuredContent).toMatchObject({ view: "status", status: "CONNECTED", backend: "local" });
    const bad = (await client.callTool({ name: "wallet_send", arguments: { amount: "1", recipient: "nobody", tokenAddress: "USDC" } })) as { isError: boolean; content: { text: string }[] };
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("TARGET_NOT_FOUND");
    await client.close();
  });
});

describe("fleet over HTTP", () => {
  it("owner creates agents, agent acts as itself, console shows the fleet", async () => {
    const made = await post("/v1/owner/exec", { command: "owner.fleet-create", params: { role: "tester", count: 2, dailyLimitUsd: 1 } }, "owner-secret-token");
    expect(made.status).toBe(200);
    const [a, b] = made.body.data.agents as { name: string; token: string; address: string }[];
    const who = await post("/v1/exec", { command: "wallet.whoami" }, a.token);
    expect(who.body.data).toMatchObject({ agent: { name: "tester-01" }, address: a.address });
    const settings = await post("/v1/exec", { command: "wallet.settings" }, b.token);
    expect(settings.body.data.dailyLimit).toBe(1);
    // agent tokens cannot reach fleet commands
    const denied = await post("/v1/exec", { command: "owner.fleet-kill", params: { target: "tester-01" } }, a.token);
    expect(denied.body.error.name).toBe("OWNER_REQUIRED");
    const list = await post("/v1/owner/exec", { command: "owner.fleet-list" }, "owner-secret-token");
    expect(list.body.data.agents.map((x: { name: string }) => x.name)).toEqual(["tester-01", "tester-02"]);
    const page = await (await fetch(base + "/")).text();
    expect(page).toContain('id="fleet"');
    expect(page).toContain("owner.fleet-list");
  });
});
