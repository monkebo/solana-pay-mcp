import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { address, appendTransactionMessageInstructions, compileTransaction, createTransactionMessage, getBase64EncodedWireTransaction, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, type Blockhash } from "@solana/kit";
import { getAddMemoInstruction } from "@solana-program/memo";

process.env.SAW_HOME = mkdtempSync(join(tmpdir(), "saw-"));
process.env.SOLANA_CLUSTER = "mainnet";

await import("../src/commands/index.js");
const { exec } = await import("../src/core/registry.js");
const { createCtx } = await import("../src/core/ctx.js");
const { keygen, walletAddress } = await import("../src/core/signer.js");
const policy = await import("../src/core/policy.js");
const { orders } = await import("../src/core/orders.js");
const { SOL_MINT, USDC_MINT } = await import("../src/core/tokens.js");

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const send = <T>(v: T) => ({ send: async () => v });
let sigStatus: unknown = null;
const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const posted: { path: string; body: unknown }[] = [];
let me: string;
let unsignedTx: string;

const rpc = {
  getBalance: () => send({ value: 1_000_000_000n }),
  getTokenAccountsByOwner: (_o: string, f: { programId?: string; mint?: string }) =>
    send({
      value: f.programId && !f.programId.startsWith("Tokenkeg")
        ? []
        : [{ pubkey: "7kfnqTWvzH5Nb3Z1WvcyWJoqXy6jkGzhKqpSAYZw1jXk", account: { data: { parsed: { info: { mint: USDC_MINT.mainnet, tokenAmount: { amount: "500000000", decimals: 6 }, delegate: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4", delegatedAmount: { amount: "18446744073709551615" } } } } } }],
    }),
  getRecentPrioritizationFees: () => send([{ prioritizationFee: 5000n, slot: 1n }]),
  getLatestBlockhash: () => send({ value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1000n } }),
  simulateTransaction: () => send({ value: { err: null, logs: [], unitsConsumed: 50_000n } }),
  sendTransaction: () => send(SIG),
  getSignatureStatuses: () => send({ value: [sigStatus] }),
  getBlockHeight: () => send(900n),
  getSignaturesForAddress: () => send([]),
  getAccountInfo: () => send({ value: null }),
} as never;

const fetchMock = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  if (u.includes("/price/v3")) return json({ [SOL_MINT]: { usdPrice: 100 }, [USDC_MINT.mainnet]: { usdPrice: 1 }, [BONK]: { usdPrice: 0.00002 } });
  if (u.includes("/tokens/v2/search")) {
    const q = decodeURIComponent(u.split("query=")[1]);
    if (q === BONK) return json([{ id: BONK, symbol: "Bonk", name: "Bonk", decimals: 5, isVerified: true, audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true, topHoldersPercentage: 12 }, liquidity: 5_000_000, organicScoreLabel: "high" }]);
    return json([]);
  }
  if (u.includes("/swap/v1/quote")) return json({ inputMint: USDC_MINT.mainnet, inAmount: "10000000", outputMint: SOL_MINT, outAmount: "99000000", otherAmountThreshold: "98500000", swapMode: "ExactIn", slippageBps: 50, priceImpactPct: "0.0001", routePlan: [{ swapInfo: { label: "Orca", ammKey: "x", inputMint: USDC_MINT.mainnet, outputMint: SOL_MINT, inAmount: "1", outAmount: "1", feeAmount: "0", feeMint: SOL_MINT }, percent: 100 }] });
  if (u.includes("/swap/v1/swap")) {
    posted.push({ path: "swap", body: JSON.parse(String(init?.body)) });
    return json({ swapTransaction: unsignedTx, lastValidBlockHeight: 1200 });
  }
  if (u.includes("/trigger/v1/createOrder")) {
    posted.push({ path: "createOrder", body: JSON.parse(String(init?.body)) });
    return json({ requestId: "req1", transaction: unsignedTx, order: "ORDERKEY111111111111111111111111111111111111" });
  }
  if (u.includes("/trigger/v1/execute")) return json({ signature: SIG, status: "Success" });
  if (u.includes("/trigger/v1/cancelOrder")) return json({ requestId: "req2", transaction: unsignedTx });
  if (u.includes("/trigger/v1/getTriggerOrders")) return json({ orders: [] });
  return json({ error: "no mock for " + u }, 404);
}) as unknown as typeof fetch;

let token: string;
const agent = () => createCtx({ role: "agent", token, rpc, fetch: fetchMock });

beforeAll(async () => {
  await keygen();
  me = await walletAddress();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(me), m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi" as Blockhash, lastValidBlockHeight: 1000n }, m),
    (m) => appendTransactionMessageInstructions([getAddMemoInstruction({ memo: "x" })], m),
  );
  unsignedTx = getBase64EncodedWireTransaction(compileTransaction(msg));
  const s = (await exec(createCtx({ role: "agent" }), "auth.signin", {})) as { qrCodeId: string };
  token = ((await exec(createCtx({ role: "agent" }), "auth.verify", { qrCodeId: s.qrCodeId })) as { token: string }).token;
  policy.patchPolicy({ maxPaymentUsd: "1000", dailyLimitUsd: "1000" });
});

describe("market orders", () => {
  it("quotes", async () => {
    const q = (await exec(agent(), "market-order.quote", { fromTokenQty: "10", fromToken: "USDC", toToken: "SOL" })) as Record<string, unknown>;
    expect(q.toCoinAmount).toBe("0.099");
    expect(q.minimumReceived).toBe("0.0985");
    expect(q.slippage).toBe(0.005);
    expect(q.route).toEqual(["Orca"]);
  });
  it("swaps within policy and tracks to FINISHED", async () => {
    const r = (await exec(agent(), "market-order.swap", { fromTokenQty: "10", fromToken: "USDC", toToken: "SOL" })) as Record<string, string>;
    expect(r.status).toBe("PENDING");
    expect(r.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/); // real signature of the wallet-signed tx
    expect(posted.at(-1)!.body).toMatchObject({ userPublicKey: me, dynamicSlippage: true });
    let l = (await exec(agent(), "market-order.list", { orderId: r.orderId })) as { list: { status: string }[] };
    expect(l.list[0].status).toBe("PENDING");
    sigStatus = { err: null, confirmationStatus: "confirmed" };
    l = (await exec(agent(), "market-order.list", { status: "FINISHED" })) as { list: { status: string; fromTokenName: string }[] };
    expect(l.list[0].status).toBe("FINISHED");
    expect(l.list[0].fromTokenName).toBe("USDC");
  });
  it("refuses tokens outside the allow list, and allows them once tradeAllTokens is on", async () => {
    await expect(exec(agent(), "market-order.swap", { fromTokenQty: "10", fromToken: "USDC", toToken: BONK })).rejects.toMatchObject({ name: "TOKEN_NOT_ALLOWED" });
    policy.patchPolicy({ tradeAllTokens: "true" });
    const a = (await exec(agent(), "token.audit", { tokenAddress: BONK })) as { riskLevel: string; hasResult: boolean };
    expect(a.hasResult).toBe(true);
    expect(a.riskLevel).toBe("low");
  });
});

describe("limit orders", () => {
  it("places a buy as a Jupiter trigger order", async () => {
    sigStatus = null;
    const r = (await exec(agent(), "limit-order.buy", { triggerPrice: "80", fromTokenQty: "10", fromToken: "USDC", toToken: "SOL" })) as Record<string, string>;
    expect(r.status).toBe("WORKING");
    expect(r.strategyId).toMatch(/^ORDERKEY/);
    const body = posted.at(-1)!.body as { params: { makingAmount: string; takingAmount: string } };
    expect(body.params.makingAmount).toBe("10000000");
    expect(body.params.takingAmount).toBe("125000000"); // 10 USDC / $80 = 0.125 SOL
    const l = (await exec(agent(), "limit-order.list", {})) as { list: { status: string; strategyId: string; side: string }[] };
    expect(l.list[0]).toMatchObject({ status: "WORKING", side: "BUY" });
    const c = (await exec(agent(), "limit-order.cancel", { strategyId: r.strategyId })) as { status: string };
    expect(c.status).toBe("CANCELED");
    expect(orders.all().find((o) => o.kind === "limit")!.status).toBe("CANCELED");
  });
  it("rejects a sell into a non-quote asset and tiny orders", async () => {
    await expect(exec(agent(), "limit-order.sell", { triggerPrice: "1", fromTokenQty: "10", fromToken: "USDC", toToken: BONK })).rejects.toMatchObject({ name: "INVALID_PARAM" });
    await expect(exec(agent(), "limit-order.buy", { triggerPrice: "80", fromTokenQty: "1", fromToken: "USDC", toToken: "SOL" })).rejects.toThrow(/at least \$5/);
  });
});

describe("approvals", () => {
  it("lists an unlimited delegate as high risk and revokes it", async () => {
    sigStatus = { err: null, confirmationStatus: "confirmed" };
    const l = (await exec(agent(), "approvals.list", {})) as { list: { amount: string; riskyLevel: string; spender: string; tokenSymbol: string }[] };
    expect(l.list[0]).toMatchObject({ amount: "unlimited", riskyLevel: "high", tokenSymbol: "USDC" });
    const d = (await exec(agent(), "approvals.detail", { tokenContract: USDC_MINT.mainnet, spender: l.list[0].spender })) as { detail: { balance: string } };
    expect(d.detail.balance).toBe("500");
    const r = (await exec(agent(), "approvals.revoke", { tokenContract: USDC_MINT.mainnet, spender: l.list[0].spender })) as { status: string };
    expect(r.status).toBe("BROADCASTED");
    await expect(exec(agent(), "approvals.detail", { tokenContract: USDC_MINT.mainnet, spender: "nobody111111111111111111111111111111111111" })).rejects.toMatchObject({ name: "TARGET_NOT_FOUND" });
  });
});
