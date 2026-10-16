import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyPairSignerFromPrivateKeyBytes, getBase64Decoder, getBase64Encoder, signBytes } from "@solana/kit";

process.env.SAW_HOME = mkdtempSync(join(tmpdir(), "saw-"));
process.env.SOLANA_CLUSTER = "mainnet";

await import("../src/commands/index.js");
const { exec } = await import("../src/core/registry.js");
const { createCtx } = await import("../src/core/ctx.js");
const { keygen } = await import("../src/core/signer.js");
const { addContact } = await import("../src/core/addressbook.js");
const policy = await import("../src/core/policy.js");
const { orders } = await import("../src/core/orders.js");
const { setBawRunner, BAW_SOL } = await import("../src/backends/baw.js");
const { SOL_MINT, USDC_MINT } = await import("../src/core/tokens.js");

const KEVIN = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const BAW_ADDR = "GG6uob9Gn8sTojdK6w2vXeoSqft82reYaTvAzZtrdNuf";
const send = <T>(v: T) => ({ send: async () => v });
const SIG = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";
const bawCalls: string[][] = [];
let lastSignerCall: { message: string; address: string } | undefined;

// A remote signer that holds its own key, like Turnkey or Privy would.
const remoteKey = await createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(7));

const rpc = {
  getBalance: () => send({ value: 1_000_000_000n }),
  getTokenAccountsByOwner: () => send({ value: [{ pubkey: "ata", account: { data: { parsed: { info: { mint: USDC_MINT.mainnet, tokenAmount: { amount: "50000000", decimals: 6 } } } } } }] }),
  getRecentPrioritizationFees: () => send([]),
  getLatestBlockhash: () => send({ value: { blockhash: "GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi", lastValidBlockHeight: 1000n } }),
  simulateTransaction: () => send({ value: { err: null, logs: [], unitsConsumed: 20_000n } }),
  sendTransaction: () => send(SIG),
  getSignatureStatuses: () => send({ value: [{ err: null, confirmationStatus: "confirmed" }] }),
  getBlockHeight: () => send(900n),
} as never;

const fetchMock = (async (url: string, init?: RequestInit) => {
  const u = String(url);
  if (u.includes("/price/v3")) return new Response(JSON.stringify({ [SOL_MINT]: { usdPrice: 100 }, [USDC_MINT.mainnet]: { usdPrice: 1 } }));
  if (u === "https://signer.test/address") return new Response(JSON.stringify({ address: remoteKey.address }));
  if (u === "https://signer.test/sign") {
    lastSignerCall = JSON.parse(String(init?.body));
    const msg = new Uint8Array(getBase64Encoder().encode(lastSignerCall!.message));
    const sig = await signBytes(remoteKey.keyPair.privateKey, msg);
    return new Response(JSON.stringify({ signature: getBase64Decoder().decode(sig) }));
  }
  if (u.includes("/swap/v1/quote")) return new Response(JSON.stringify({ inputMint: USDC_MINT.mainnet, inAmount: "10000000", outputMint: SOL_MINT, outAmount: "99000000", otherAmountThreshold: "98000000", swapMode: "ExactIn", slippageBps: 50, priceImpactPct: "0", routePlan: [] }));
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
  policy.patchPolicy({ dailyLimitUsd: "1000", maxPaymentUsd: "1000", tradeAllTokens: "true" });
  setBawRunner(async (args) => {
    bawCalls.push(args);
    const key = args.slice(0, 2).join(" ");
    switch (key) {
      case "wallet address":
        return { addresses: [{ binanceChainId: "CT_501", chainName: "Solana", address: BAW_ADDR }, { binanceChainId: "56", chainName: "BSC", address: "0xabc" }] };
      case "wallet status":
        return { status: "CONNECTED" };
      case "wallet balance":
        return [{ symbol: "USDC", address: USDC_MINT.mainnet, binanceChainId: "CT_501", balance: "120.5", price: "1.0", value: "120.50" }, { symbol: "SOL", address: BAW_SOL, binanceChainId: "CT_501", balance: "2", price: "100", value: "200.00" }];
      case "wallet send":
        return { txHash: SIG };
      case "market-order swap":
        return { orderId: "bnb-order-1" };
      case "defi deposit":
        return { txHash: "defiTx" };
      case "defi protocol-list":
        return { total: 1, list: [{ defiProtocolId: "p1", protocolName: "Kamino" }] };
      case "approvals list":
        return { list: [], total: 0 };
      default:
        throw new Error("no fake for " + key);
    }
  });
});

describe("backend switch", () => {
  it("defaults to local and lists backends", async () => {
    const b = (await exec(owner(), "owner.backends", {})) as { active: { kind: string }; available: string[] };
    expect(b.active.kind).toBe("local");
    expect(b.available).toEqual(["local", "baw", "signer", "solana-pay"]);
  });

  it("the same send goes through the local key, then Binance, then a remote signer, then a human wallet", async () => {
    // 1. local key
    let r = (await exec(agent(), "wallet.send", { amount: "1", recipient: "kevin", tokenAddress: "USDC" })) as Record<string, unknown>;
    expect(r.backend).toBe("local");
    expect(r.status).toBe("BROADCASTED");

    // 2. Binance Agentic Wallet via baw
    await exec(owner(), "owner.set-backend", { kind: "baw" });
    expect(((await exec(agent(), "wallet.status", {})) as { backend: string; status: string })).toMatchObject({ backend: "baw", status: "CONNECTED" });
    expect(((await exec(agent(), "wallet.address", {})) as { addresses: { address: string }[] }).addresses[0].address).toBe(BAW_ADDR);
    const bal = (await exec(agent(), "wallet.balance", {})) as { symbol: string; address: string }[];
    expect(bal.find((b) => b.symbol === "SOL")!.address).toBe(SOL_MINT); // normalised from Binance's sentinel
    r = (await exec(agent(), "wallet.send", { amount: "2", recipient: "kevin", tokenAddress: "USDC", gasLevel: "HIGH" })) as Record<string, unknown>;
    expect(r.backend).toBe("baw");
    expect(r.txHash).toBe(SIG);
    expect(bawCalls.at(-1)).toEqual(["wallet", "send", "--amount", "2", "--recipient", KEVIN, "--binanceChainId", "CT_501", "--tokenAddress", USDC_MINT.mainnet, "--gasLevel", "HIGH"]);
    // policy still applies in front of Binance
    await expect(exec(agent(), "wallet.send", { amount: "1", recipient: "GG6uob9Gn8sTojdK6w2vXeoSqft82reYaTvAzZtrdNuf", tokenAddress: "USDC" })).rejects.toMatchObject({ name: "RECIPIENT_NOT_IN_ADDRESS_BOOK" });
    // wallet-built transactions are refused honestly
    await expect(exec(agent(), "contract-call.preview", { unsignedTx: "AAAA" })).rejects.toMatchObject({ name: "UPSTREAM_ERROR" }); // forwarded to baw, fake has no handler

    // 3. remote HTTP signer
    await exec(owner(), "owner.set-backend", { kind: "signer", url: "https://signer.test", token: "t0k" });
    expect(((await exec(agent(), "wallet.address", {})) as { addresses: { address: string }[] }).addresses[0].address).toBe(remoteKey.address);
    r = (await exec(agent(), "wallet.send", { amount: "3", recipient: "kevin", tokenAddress: "USDC" })) as Record<string, unknown>;
    expect(r.backend).toBe("signer");
    expect(r.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
    expect(lastSignerCall?.address).toBe(remoteKey.address);

    // 4. a human's wallet: the agent prepares, the human scans
    await exec(owner(), "owner.set-backend", { kind: "solana-pay", address: KEVIN, label: "Bohdan's Phantom" });
    r = (await exec(agent(), "wallet.send", { amount: "4", recipient: "kevin", tokenAddress: "USDC" })) as Record<string, unknown>;
    expect(r.backend).toBe("solana-pay");
    expect(String(r.payUrl)).toMatch(/^solana:9WzDXw.*spl-token=EPjF/);
    expect(String(r.qrSvg)).toContain("<svg");

    // one ledger across all four
    const ledger = orders.all().filter((o) => o.kind === "send");
    expect(ledger.map((o) => o.backend)).toEqual(["local", "baw", "signer", "solana-pay"]);
    await exec(owner(), "owner.set-backend", { kind: "local" });
  });
});

describe("pass-through under policy", () => {
  it("forwards DeFi to baw with the defi quota applied, and refuses on local", async () => {
    await expect(exec(agent(), "defi.protocol-list", {})).rejects.toMatchObject({ name: "VENUE_UNAVAILABLE" });
    await exec(owner(), "owner.set-backend", { kind: "baw" });
    const list = (await exec(agent(), "defi.protocol-list", { binanceChainId: "CT_501", investType: "Earn" })) as { list: { protocolName: string }[] };
    expect(list.list[0].protocolName).toBe("Kamino");
    expect(bawCalls.at(-1)).toEqual(["defi", "protocol-list", "--binanceChainId", "CT_501", "--investType", "Earn"]);
    policy.patchPolicy({ defiDailyLimitUsd: "50" });
    const dep = (await exec(agent(), "defi.deposit", { investmentId: "inv1", tokenAddress: USDC_MINT.mainnet, amount: "20" })) as { txHash: string; orderId: string };
    expect(dep.txHash).toBe("defiTx");
    const o = orders.get(dep.orderId)!;
    expect(o).toMatchObject({ kind: "defi", category: "defi", usdValue: 20, backend: "baw" });
    await expect(exec(agent(), "defi.deposit", { investmentId: "inv1", tokenAddress: USDC_MINT.mainnet, amount: "40" })).rejects.toMatchObject({ name: "DAILY_LIMIT_EXCEEDED" });
    const sw = (await exec(agent(), "market-order.swap", { fromTokenQty: "10", fromToken: "USDC", toToken: "SOL" })) as { upstreamOrderId: string; backend: string };
    expect(sw).toMatchObject({ backend: "baw", upstreamOrderId: "bnb-order-1" });
    await exec(owner(), "owner.set-backend", { kind: "local" });
  });
});
