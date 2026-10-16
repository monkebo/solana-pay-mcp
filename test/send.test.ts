import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SAW_HOME = mkdtempSync(join(tmpdir(), "saw-"));
process.env.SOLANA_CLUSTER = "mainnet";

await import("../src/commands/index.js");
const { exec } = await import("../src/core/registry.js");
const { createCtx } = await import("../src/core/ctx.js");
const { keygen, walletAddress } = await import("../src/core/signer.js");
const { addContact } = await import("../src/core/addressbook.js");
const policy = await import("../src/core/policy.js");
const { orders } = await import("../src/core/orders.js");
const { SOL_MINT, USDC_MINT } = await import("../src/core/tokens.js");

const KEVIN = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const STRANGER = "GG6uob9Gn8sTojdK6w2vXeoSqft82reYaTvAzZtrdNuf";
const send = <T>(v: T) => ({ send: async () => v });
const calls: string[] = [];
let sigStatus: unknown = null;
let usdcUnits = "50000000"; // 50 USDC

const rpc = {
  getBalance: () => send({ value: 1_000_000_000n }),
  getTokenAccountsByOwner: (_o: string, f: { programId?: string; mint?: string }) =>
    send({ value: f.programId && !f.programId.startsWith("Tokenkeg") ? [] : [{ pubkey: "ata1", account: { data: { parsed: { info: { mint: USDC_MINT.mainnet, tokenAmount: { amount: usdcUnits, decimals: 6 } } } } } }] }),
  getRecentPrioritizationFees: () => send([{ prioritizationFee: 5000n, slot: 1n }]),
  getLatestBlockhash: () => send({ value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1000n } }),
  simulateTransaction: () => {
    calls.push("simulate");
    return send({ value: { err: null, logs: ["Program log: ok"], unitsConsumed: 20_000n } });
  },
  sendTransaction: () => {
    calls.push("send");
    return send("5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW");
  },
  getSignatureStatuses: () => send({ value: [sigStatus] }),
  getBlockHeight: () => send(900n),
} as never;

const fetchMock = (async (url: string) => {
  if (String(url).includes("/price/v3")) return new Response(JSON.stringify({ [SOL_MINT]: { usdPrice: 100 }, [USDC_MINT.mainnet]: { usdPrice: 1 } }));
  return new Response("[]");
}) as unknown as typeof fetch;

let token: string;
const agent = () => createCtx({ role: "agent", token, rpc, fetch: fetchMock });
const owner = () => createCtx({ role: "owner", rpc, fetch: fetchMock });

beforeAll(async () => {
  await keygen();
  addContact("kevin", KEVIN);
  const s = (await exec(createCtx({ role: "agent" }), "auth.signin", {})) as { qrCodeId: string };
  token = ((await exec(createCtx({ role: "agent" }), "auth.verify", { qrCodeId: s.qrCodeId })) as { token: string }).token;
});

describe("wallet send", () => {
  it("sends USDC to a contact and records a BROADCASTED order", async () => {
    const r = (await exec(agent(), "wallet.send", { amount: "12.5", recipient: "kevin", tokenAddress: "USDC" })) as Record<string, unknown>;
    expect(r.status).toBe("BROADCASTED");
    expect(r.txHash).toMatch(/^5VERv8/);
    expect(r.recipientLabel).toBe("kevin");
    expect(calls).toEqual(["simulate", "send"]);
    const o = orders.get(r.orderId as string)!;
    expect(o.status).toBe("BROADCASTED");
    expect(o.usdValue).toBe(12.5);
    expect(o.signedTx).toBeTruthy();
    // lock while pending
    await expect(exec(agent(), "wallet.send", { amount: "1", recipient: "kevin", tokenAddress: "USDC" })).rejects.toMatchObject({ name: "LOCKED" });
    const lock = (await exec(agent(), "wallet.tx-lock", {})) as { status: string };
    expect(lock.status).toBe("LOCKED");
    // speed-up rebroadcasts, cancel is impossible
    expect(((await exec(agent(), "wallet.speed-up", { txHash: r.txHash })) as { status: string }).status).toBe("SUBMITTED");
    await expect(exec(agent(), "wallet.cancel", { txHash: r.txHash })).rejects.toMatchObject({ name: "UNSUPPORTED_ON_SOLANA" });
    // confirmation unlocks and shows in settings quota
    sigStatus = { err: null, confirmationStatus: "confirmed" };
    expect(((await exec(agent(), "wallet.tx-lock", {})) as { status: string }).status).toBe("UNLOCKED");
    expect(orders.get(o.id)!.status).toBe("CONFIRMED");
    const st = (await exec(agent(), "wallet.settings", {})) as { quotaUsed: number };
    expect(st.quotaUsed).toBe(12.5);
    await expect(exec(agent(), "wallet.speed-up", { txHash: r.txHash })).rejects.toMatchObject({ name: "ALREADY_CONFIRMED" });
  });

  it("enforces address book, per-payment and token policy", async () => {
    await expect(exec(agent(), "wallet.send", { amount: "1", recipient: STRANGER, tokenAddress: "USDC" })).rejects.toMatchObject({ name: "RECIPIENT_NOT_IN_ADDRESS_BOOK" });
    await expect(exec(agent(), "wallet.send", { amount: "60", recipient: "kevin", tokenAddress: "USDC" })).rejects.toMatchObject({ name: "PAYMENT_LIMIT_EXCEEDED" });
    await expect(exec(agent(), "wallet.send", { amount: "1", recipient: "kevin", tokenAddress: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" })).rejects.toMatchObject({ name: "TOKEN_NOT_ALLOWED" });
    policy.patchPolicy({ dailyLimitUsd: "20" });
    await expect(exec(agent(), "wallet.send", { amount: "10", recipient: "kevin", tokenAddress: "USDC" })).rejects.toMatchObject({ name: "DAILY_LIMIT_EXCEEDED" });
    policy.patchPolicy({ dailyLimitUsd: "100" });
  });

  it("routes a risky transfer to owner confirmation, then approval executes it", async () => {
    policy.patchPolicy({ addressBookOnly: "false" });
    calls.length = 0;
    const r = (await exec(agent(), "wallet.send", { amount: "2", recipient: STRANGER, tokenAddress: "USDC" })) as { status: string; orderId: string; reasons: string[] };
    expect(r.status).toBe("PENDING_CONFIRMATION");
    expect(r.reasons[0]).toMatch(/address book/);
    expect(calls).toEqual([]);
    const pend = (await exec(owner(), "owner.pending", {})) as { id: string }[];
    expect(pend.map((p) => p.id)).toContain(r.orderId);
    const ap = (await exec(owner(), "owner.approve", { orderId: r.orderId })) as { result: { status: string } };
    expect(ap.result.status).toBe("BROADCASTED");
    expect(calls).toEqual(["simulate", "send"]);
    expect(orders.get(r.orderId)!.status).toBe("BROADCASTED");
    sigStatus = { err: null, confirmationStatus: "finalized" };
    await exec(agent(), "wallet.tx-lock", {});
  });

  it("AutoReject blocks instead of queueing; reject works too", async () => {
    policy.patchPolicy({ abnormalTxnHandling: '"AutoReject"' });
    await expect(exec(agent(), "wallet.send", { amount: "2", recipient: STRANGER, tokenAddress: "USDC" })).rejects.toMatchObject({ name: "RISK_BLOCKED" });
    policy.patchPolicy({ abnormalTxnHandling: '"NeedConfirmation"' });
    const r = (await exec(agent(), "wallet.send", { amount: "2", recipient: STRANGER, tokenAddress: "USDC" })) as { orderId: string };
    await exec(owner(), "owner.reject", { orderId: r.orderId, reason: "no" });
    expect(orders.get(r.orderId)!.status).toBe("REJECTED");
    policy.patchPolicy({ addressBookOnly: "true" });
  });

  it("--max SOL keeps a fee buffer and dryRun prices without sending", async () => {
    calls.length = 0;
    policy.patchPolicy({ maxPaymentUsd: "1000" });
    const d = (await exec(agent(), "wallet.send", { max: true, recipient: "kevin", tokenAddress: "SOL", dryRun: true })) as { amount: string; amountUsd: number };
    expect(Number(d.amount)).toBeLessThan(1);
    expect(Number(d.amount)).toBeGreaterThan(0.99);
    expect(calls).toEqual([]);
    const me = await walletAddress();
    expect(me).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  });

  it("simulation failure surfaces as SIMULATION_FAILED and marks the order FAILED", async () => {
    const bad = { ...(rpc as object), simulateTransaction: () => send({ value: { err: { InstructionError: [2, { Custom: 1 }] }, logs: ["Program log: Error: insufficient funds"], unitsConsumed: 0n } }) } as never;
    const ctx = createCtx({ role: "agent", token, rpc: bad, fetch: fetchMock });
    await expect(exec(ctx, "wallet.send", { amount: "1", recipient: "kevin", tokenAddress: "USDC" })).rejects.toMatchObject({ name: "SIMULATION_FAILED" });
    expect(orders.all().at(-1)!.status).toBe("FAILED");
  });
});
