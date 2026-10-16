import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SAW_HOME = mkdtempSync(join(tmpdir(), "saw-fleet-"));
process.env.SOLANA_CLUSTER = "mainnet";

await import("../src/commands/index.js");
const { exec } = await import("../src/core/registry.js");
const { createCtx } = await import("../src/core/ctx.js");
const { keygen } = await import("../src/core/signer.js");
const { agents } = await import("../src/core/agents.js");
const { orders } = await import("../src/core/orders.js");
const { SOL_MINT, USDC_MINT } = await import("../src/core/tokens.js");

const send = <T>(v: T) => ({ send: async () => v });
let sent = 0;
const rpc = {
  getBalance: () => send({ value: 1_000_000_000n }),
  getTokenAccountsByOwner: () => send({ value: [{ pubkey: "ata", account: { data: { parsed: { info: { mint: USDC_MINT.mainnet, tokenAmount: { amount: "5000000", decimals: 6 } } } } } }] }),
  getRecentPrioritizationFees: () => send([{ prioritizationFee: 5000n, slot: 1n }]),
  getLatestBlockhash: () => send({ value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1000n } }),
  simulateTransaction: () => send({ value: { err: null, logs: [], unitsConsumed: 20_000n } }),
  sendTransaction: () => {
    sent++;
    return send(`${"5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQU".slice(0, 86 - String(sent).length)}${sent}`);
  },
  getSignatureStatuses: (sigs: string[]) => send({ value: sigs.map(() => ({ err: null, confirmationStatus: "confirmed" })) }),
  // fleet-list reads balances in two batched calls: token accounts (jsonParsed) then owners (lamports)
  getMultipleAccounts: (keys: string[], cfg?: { encoding?: string }) =>
    send({ value: keys.map(() => (cfg?.encoding === "jsonParsed" ? { lamports: 2039280n, data: { parsed: { info: { mint: USDC_MINT.mainnet, tokenAmount: { amount: "5000000", decimals: 6 } } } } } : { lamports: 1_000_000_000n })) }),
  getBlockHeight: () => send(900n),
} as never;
const fetchMock = (async (url: string) => (String(url).includes("/price/v3") ? new Response(JSON.stringify({ [SOL_MINT]: { usdPrice: 100 }, [USDC_MINT.mainnet]: { usdPrice: 1 } })) : new Response("[]"))) as unknown as typeof fetch;

const owner = () => createCtx({ role: "owner", rpc, fetch: fetchMock });
const as = (token: string) => createCtx({ role: "agent", token, rpc, fetch: fetchMock });
type Made = { agents: { id: string; name: string; address: string; token: string }[] };
let a1: Made["agents"][0], a2: Made["agents"][0], buyer: Made["agents"][0];

beforeAll(async () => {
  await keygen(); // treasury
});

describe("fleet", () => {
  it("creates agents with their own keys, contacts and tokens", async () => {
    const r = (await exec(owner(), "owner.fleet-create", { role: "translator", count: 2, dailyLimitUsd: 1, maxPaymentUsd: 0.5 })) as Made;
    [a1, a2] = r.agents;
    expect(r.agents.map((a) => a.name)).toEqual(["translator-01", "translator-02"]);
    expect(a1.address).not.toBe(a2.address);
    expect(existsSync(agents.get(a1.id)!.keyPath)).toBe(true);
    const b = (await exec(owner(), "owner.fleet-create", { role: "buyer", name: "buyer-x" })) as Made;
    buyer = b.agents[0];
    const who = (await exec(as(buyer.token), "wallet.whoami", {})) as { agent: { name: string }; address: string };
    expect(who.agent.name).toBe("buyer-x");
    expect(who.address).toBe(buyer.address);
  });

  it("agents pay each other by name, each under its own limits and lock", async () => {
    const r = (await exec(as(buyer.token), "wallet.send", { amount: "0.3", recipient: "translator-01", tokenAddress: "USDC", memo: "job 1" })) as { status: string; orderId: string; recipient: string };
    expect(r.status).toBe("BROADCASTED");
    expect(r.recipient).toBe(a1.address);
    expect(orders.get(r.orderId)!.agentId).toBe(buyer.id);
    // translator-01's own quota is untouched by the buyer's spend; its per-payment cap is its own 0.5
    await expect(exec(as(a1.token), "wallet.send", { amount: "0.6", recipient: "translator-02", tokenAddress: "USDC" })).rejects.toMatchObject({ name: "PAYMENT_LIMIT_EXCEEDED" });
    // the buyer's pending tx locks only the buyer, not translator-01
    const r2 = (await exec(as(a1.token), "wallet.send", { amount: "0.2", recipient: "translator-02", tokenAddress: "USDC" })) as { status: string };
    expect(r2.status).toBe("BROADCASTED");
    // daily limit is per agent: translator-01 has $1/day (the mock RPC confirms instantly, so no lock)
    await exec(as(a1.token), "wallet.send", { amount: "0.5", recipient: "translator-02", tokenAddress: "USDC" });
    await expect(exec(as(a1.token), "wallet.send", { amount: "0.4", recipient: "translator-02", tokenAddress: "USDC" })).rejects.toMatchObject({ name: "DAILY_LIMIT_EXCEEDED" });
  });

  it("lists spend per agent and the fleet total", async () => {
    const l = (await exec(owner(), "owner.fleet-list", { balances: true })) as { total: number; spentTodayUsd: number; agents: { name: string; spentTodayUsd: number; dailyLimitUsd: number; usdc: string; sol: string }[] };
    expect(l.total).toBe(3);
    const t1 = l.agents.find((a) => a.name === "translator-01")!;
    expect(t1.spentTodayUsd).toBe(0.7);
    expect(t1.dailyLimitUsd).toBe(1);
    expect(t1.usdc).toBe("5");
    expect(l.spentTodayUsd).toBe(1);
  });

  it("pause, resume and kill", async () => {
    await exec(owner(), "owner.fleet-pause", { target: "buyer-x", reason: "burning budget" });
    await expect(exec(as(buyer.token), "wallet.send", { amount: "0.1", recipient: "translator-01", tokenAddress: "USDC" })).rejects.toMatchObject({ name: "AGENT_PAUSED" });
    await exec(owner(), "owner.fleet-resume", { target: "buyer-x" });
    await exec(owner(), "owner.fleet-pause", { target: "all" });
    await expect(exec(as(buyer.token), "wallet.send", { amount: "0.1", recipient: "translator-01", tokenAddress: "USDC" })).rejects.toMatchObject({ name: "FLEET_PAUSED" });
    await exec(owner(), "owner.fleet-resume", { target: "all" });
    const k = (await exec(owner(), "owner.fleet-kill", { target: "translator-02", reason: "cheating" })) as { killed: { sessionsRevoked: number }[] };
    expect(k.killed[0].sessionsRevoked).toBe(1);
    await expect(exec(as(a2.token), "wallet.whoami", {})).rejects.toMatchObject({ name: "NOT_SIGNED_IN" });
    expect(agents.get(a2.id)!.status).toBe("killed");
  });

  it("policy overrides by role", async () => {
    await exec(owner(), "owner.fleet-set-policy", { target: "translator", assignments: ["maxPaymentUsd=0.05"] });
    expect(agents.get(a1.id)!.policy.maxPaymentUsd).toBe(0.05);
    await expect(exec(as(a1.token), "wallet.send", { amount: "0.1", recipient: "translator-02", tokenAddress: "USDC" })).rejects.toMatchObject({ name: "PAYMENT_LIMIT_EXCEEDED" });
  });

  it("funds agents from the treasury in batches and shows everything in one ledger", async () => {
    const before = sent;
    const f = (await exec(owner(), "owner.fleet-fund", { amount: 2, sol: 0.02 })) as { funded: number; transactions: unknown[] };
    expect(f.funded).toBe(2); // killed agent skipped
    expect(f.transactions).toHaveLength(1);
    expect(sent - before).toBe(1);
    const led = (await exec(owner(), "owner.fleet-ledger", { limit: 10 })) as { rows: { agent: string; to: string | null; amount: string | null; status: string }[] };
    expect(led.rows[0]).toMatchObject({ agent: "treasury", to: "buyer-x, translator-01" });
    expect(led.rows.some((r) => r.agent === "buyer-x" && r.to === "translator-01" && r.amount === "0.3")).toBe(true);
  });
});
