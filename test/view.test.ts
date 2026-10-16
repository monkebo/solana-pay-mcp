import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.SAW_HOME = mkdtempSync(join(tmpdir(), "saw-"));
process.env.SOLANA_CLUSTER = "mainnet";

const { balances, describeTx, gasLevels } = await import("../src/core/view.js");
const { createCtx } = await import("../src/core/ctx.js");
const { SOL_MINT, USDC_MINT } = await import("../src/core/tokens.js");

const OWNER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const OTHER = "GG6uob9Gn8sTojdK6w2vXeoSqft82reYaTvAzZtrdNuf";
const send = <T>(v: T) => ({ send: async () => v });

function fakeRpc(over: Record<string, unknown> = {}) {
  return {
    getBalance: () => send({ value: 1_500_000_000n }),
    getTokenAccountsByOwner: (_o: string, f: { programId: string }) =>
      send({
        value: f.programId.startsWith("Tokenkeg")
          ? [{ pubkey: "ata1", account: { data: { parsed: { info: { mint: USDC_MINT.mainnet, tokenAmount: { amount: "12500000", decimals: 6 } } } } } }]
          : [],
      }),
    getRecentPrioritizationFees: () => send([1000, 0, 5000, 20000, 20000, 300000, 50000, 0, 7000, 100000].map((f, i) => ({ prioritizationFee: BigInt(f), slot: BigInt(i) }))),
    ...over,
  } as never;
}

const fakeFetch = (async (url: string) => {
  if (String(url).includes("/price/v3")) return new Response(JSON.stringify({ [SOL_MINT]: { usdPrice: 150 }, [USDC_MINT.mainnet]: { usdPrice: 1 } }));
  return new Response("[]");
}) as unknown as typeof fetch;

describe("balances", () => {
  it("lists SOL and tokens with USD values, sorted by value", async () => {
    const ctx = createCtx({ rpc: fakeRpc(), fetch: fakeFetch });
    const rows = await balances(ctx, OWNER as never);
    expect(rows.map((r) => [r.symbol, r.balance, r.value])).toEqual([
      ["SOL", "1.5", "225.00"],
      ["USDC", "12.5", "12.50"],
    ]);
    expect(rows[1].program).toBe("token");
  });
});

describe("describeTx", () => {
  const sym = (m: string) => (m === SOL_MINT ? "SOL" : m === USDC_MINT.mainnet ? "USDC" : "?");
  it("reads a USDC send with memo", () => {
    const row = describeTx(
      "sig1",
      {
        slot: 10n,
        blockTime: 1_700_000_000n,
        meta: {
          err: null,
          fee: 5000n,
          preBalances: [10_000_000n, 2_000_000n],
          postBalances: [9_995_000n, 2_000_000n],
          preTokenBalances: [
            { accountIndex: 2, mint: USDC_MINT.mainnet, owner: OWNER, uiTokenAmount: { amount: "5000000", decimals: 6 } },
            { accountIndex: 3, mint: USDC_MINT.mainnet, owner: OTHER, uiTokenAmount: { amount: "0", decimals: 6 } },
          ],
          postTokenBalances: [
            { accountIndex: 2, mint: USDC_MINT.mainnet, owner: OWNER, uiTokenAmount: { amount: "3000000", decimals: 6 } },
            { accountIndex: 3, mint: USDC_MINT.mainnet, owner: OTHER, uiTokenAmount: { amount: "2000000", decimals: 6 } },
          ],
          logMessages: ['Program log: Memo (len 6): "coffee"'],
        },
        transaction: { message: { accountKeys: [{ pubkey: OWNER }, { pubkey: OTHER }, { pubkey: "ataA" }, { pubkey: "ataB" }] } },
      },
      OWNER,
      sym,
    );
    expect(row.txType).toBe("send");
    expect(row.status).toBe("confirmed");
    expect(row.memo).toBe("coffee");
    const leg = row.txHashList[0].instructions.send[0];
    expect(leg.amount).toBe("2000000");
    expect(leg.addressInfo.address).toBe(OTHER);
    expect(leg.tokenInfo.symbol).toBe("USDC");
    expect(row.txHashList[0].instructions.receive).toEqual([]);
  });
  it("reads a SOL receive and a failed tx", () => {
    const base = {
      slot: 1n,
      blockTime: null,
      transaction: { message: { accountKeys: [{ pubkey: OTHER }, { pubkey: OWNER }] } },
    };
    const ok = describeTx("s", { ...base, meta: { err: null, fee: 5000n, preBalances: [5_000_000n, 0n], postBalances: [3_995_000n, 1_000_000n] } }, OWNER, sym);
    expect(ok.txType).toBe("receive");
    expect(ok.txHashList[0].instructions.receive[0].amount).toBe("1000000");
    expect(ok.txHashList[0].instructions.receive[0].addressInfo.address).toBe(OTHER);
    const bad = describeTx("s", { ...base, meta: { err: { InstructionError: [0, "Custom"] }, fee: 5000n, preBalances: [5n, 0n], postBalances: [5n, 0n] } }, OWNER, sym);
    expect(bad.status).toBe("failed");
    expect(bad.txType).toBe("other");
  });
});

describe("gas levels", () => {
  it("builds tiers from percentiles with floors", async () => {
    const g = await gasLevels(createCtx({ rpc: fakeRpc() }));
    expect(Number(g.low.gasPrice)).toBeLessThanOrEqual(Number(g.medium.gasPrice));
    expect(Number(g.medium.gasPrice)).toBeLessThanOrEqual(Number(g.high.gasPrice));
    expect(g.high.gasPrice).toBe("300000");
    expect(g.medium.tipAmount).toBe("0.000004"); // 20000 µlam × 200k CU
  });
});
