import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getBase64Encoder, getTransactionDecoder } from "@solana/kit";

process.env.SAW_HOME = mkdtempSync(join(tmpdir(), "saw-"));
process.env.SOLANA_CLUSTER = "mainnet";

await import("../src/commands/index.js");
const { exec } = await import("../src/core/registry.js");
const { createCtx } = await import("../src/core/ctx.js");
const { keygen, walletAddress } = await import("../src/core/signer.js");
const { SOL_MINT, USDC_MINT } = await import("../src/core/tokens.js");
const { X402_NETWORK } = await import("../src/core/config.js");

const send = <T>(v: T) => ({ send: async () => v });
const FEE_PAYER = "GG6uob9Gn8sTojdK6w2vXeoSqft82reYaTvAzZtrdNuf";
const MERCHANT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
let usdc = "1000000"; // 1 USDC
const rpc = {
  getBalance: () => send({ value: 1_000_000_000n }),
  getTokenAccountsByOwner: () => send({ value: [{ pubkey: "ata", account: { data: { parsed: { info: { mint: USDC_MINT.mainnet, tokenAmount: { amount: usdc, decimals: 6 } } } } } }] }),
  getLatestBlockhash: () => send({ value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1000n } }),
  getSignatureStatuses: () => send({ value: [] }),
} as never;

const required = {
  x402Version: 2,
  resource: { url: "https://merchant.example/api/report" },
  accepts: [
    { scheme: "exact", network: "eip155:8453", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amount: "10000000", payTo: "0x1111111111111111111111111111111111111111", extra: { name: "USD Coin", version: "2" } },
    { scheme: "exact", network: X402_NETWORK.mainnet, asset: USDC_MINT.mainnet, amount: "500000", payTo: MERCHANT, maxTimeoutSeconds: 60, extra: { feePayer: FEE_PAYER } },
    { scheme: "exact", network: X402_NETWORK.mainnet, asset: USDC_MINT.mainnet, amount: "2500000", payTo: MERCHANT, extra: { feePayer: FEE_PAYER } },
    { scheme: "upto", network: X402_NETWORK.mainnet, asset: USDC_MINT.mainnet, amount: "1", payTo: MERCHANT, extra: { feePayer: FEE_PAYER } },
  ],
};

let served402 = 0;
const fetchMock = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  if (u.includes("/price/v3")) return new Response(JSON.stringify({ [SOL_MINT]: { usdPrice: 100 }, [USDC_MINT.mainnet]: { usdPrice: 1 } }));
  if (u.startsWith("https://merchant.example/")) {
    const h = new Headers(init?.headers as Record<string, string>);
    if (!h.get("PAYMENT-SIGNATURE")) {
      served402++;
      return new Response(JSON.stringify(required), { status: 402, headers: { "payment-required": Buffer.from(JSON.stringify(required)).toString("base64") } });
    }
    const payload = JSON.parse(Buffer.from(h.get("PAYMENT-SIGNATURE")!, "base64").toString());
    expect(payload.x402Version).toBe(2);
    expect(payload.accepted.payTo).toBe(MERCHANT);
    const tx = getTransactionDecoder().decode(new Uint8Array(getBase64Encoder().encode(payload.payload.transaction)));
    expect(Object.keys(tx.signatures)).toContain(FEE_PAYER); // fee payer slot present, unsigned
    return new Response(JSON.stringify({ report: "ok" }), { status: 200, headers: { "payment-response": Buffer.from(JSON.stringify({ success: true, transaction: "5igTxHash", network: X402_NETWORK.mainnet })).toString("base64") } });
  }
  return new Response("[]");
}) as unknown as typeof fetch;

let token: string;
const agent = () => createCtx({ role: "agent", token, rpc, fetch: fetchMock });

beforeAll(async () => {
  await keygen();
  const s = (await exec(createCtx({ role: "agent" }), "auth.signin", {})) as { qrCodeId: string };
  token = ((await exec(createCtx({ role: "agent" }), "auth.verify", { qrCodeId: s.qrCodeId })) as { token: string }).token;
});

describe("x402", () => {
  it("previews and ranks options", async () => {
    const pv = (await exec(agent(), "x402-payment.preview", { paymentRequirements: Buffer.from(JSON.stringify(required)).toString("base64") })) as { paymentId: string; options: Record<string, unknown>[] };
    expect(pv.options.map((o) => [o.status, (o.reasons as string[])[0] ?? null])).toEqual([
      ["READY_TO_SIGN", null],
      ["ACTION_REQUIRED", "INSUFFICIENT_BALANCE"],
      ["NOT_SIGNABLE", "UNSUPPORTED_NETWORK"],
      ["NOT_SIGNABLE", "UNSUPPORTED_SCHEME"],
    ]);
    expect(pv.options[0]).toMatchObject({ amount: "0.5", amountUsd: "0.50", tokenSymbol: "USDC", currentBalance: "1", assetTransferMethod: "spl-transfer", userWalletAddress: await walletAddress() });
    await expect(exec(agent(), "x402-payment.sign", { paymentId: pv.paymentId, selectedIndex: 3 })).rejects.toMatchObject({ name: "NOT_SUPPORTED" });
    await expect(exec(agent(), "x402-payment.sign", { paymentId: pv.paymentId, selectedIndex: 2 })).rejects.toMatchObject({ name: "INSUFFICIENT_BALANCE" });
    const s = (await exec(agent(), "x402-payment.sign", { paymentId: pv.paymentId, selectedIndex: 1 })) as Record<string, unknown>;
    expect(s.paymentHeaderName).toBe("PAYMENT-SIGNATURE");
    expect(typeof s.paymentHeaderValue).toBe("string");
    expect(s.approveTxHash).toBeNull();
    await expect(exec(agent(), "x402-payment.sign", { paymentId: pv.paymentId, selectedIndex: 1 })).rejects.toMatchObject({ name: "TARGET_NOT_FOUND" }); // one use
  });
  it("pays a 402 resource end to end and records settlement", async () => {
    const r = (await exec(agent(), "x402-payment.pay", { url: "https://merchant.example/api/report" })) as Record<string, unknown>;
    expect(served402).toBe(1);
    expect(r.paid).toBe(true);
    expect(r.body).toContain("ok");
    expect((r.settlement as { transaction: string }).transaction).toBe("5igTxHash");
    const list = (await exec(agent(), "x402-payment.list", {})) as { txHash: string | null; amountUsd: number }[];
    expect(list[0].txHash).toBe("5igTxHash");
    const st = (await exec(agent(), "wallet.settings", {})) as { x402QuotaUsed: number };
    expect(st.x402QuotaUsed).toBe(1);
  });
  it("blocks over the x402 daily limit", async () => {
    const big = { ...required, accepts: [{ ...required.accepts[1], amount: "25000000" }] }; // $25 > $20 x402 limit
    const pv = (await exec(agent(), "x402-payment.preview", { paymentRequirements: JSON.stringify(big) })) as { options: { status: string; reasons: string[] }[] };
    expect(pv.options[0].status).toBe("NOT_SIGNABLE");
    expect(pv.options[0].reasons).toContain("BLOCKED_DAILY_LIMIT_REACHED");
  });
});
