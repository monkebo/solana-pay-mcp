// Read-only chain views: balances with USD values, transaction history, priority-fee levels.
import { address, type Address, type Signature } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { Ctx } from "./ctx.js";
import { CHAIN_ID, explorerUrl } from "./config.js";
import { fromUnits, jupiterTokenInfo, known, SOL_MINT, TOKEN_2022_PROGRAM_ADDRESS } from "./tokens.js";
import { prices, fmtUsd } from "./prices.js";
import { orders } from "./orders.js";
import { refreshPending } from "./track.js";

export interface BalanceRow {
  symbol: string;
  address: string;
  binanceChainId: string;
  balance: string;
  decimals: number;
  price: string | null;
  value: string | null;
  program: "system" | "token" | "token-2022";
}

interface ParsedTokenAccount {
  account: { data: { parsed: { info: { mint: string; tokenAmount: { amount: string; decimals: number }; delegate?: string; delegatedAmount?: { amount: string } } } } };
  pubkey: string;
}

async function tokenAccounts(ctx: Ctx, owner: Address): Promise<{ program: "token" | "token-2022"; rows: ParsedTokenAccount[] }[]> {
  const out: { program: "token" | "token-2022"; rows: ParsedTokenAccount[] }[] = [];
  for (const [program, programId] of [["token", TOKEN_PROGRAM_ADDRESS], ["token-2022", TOKEN_2022_PROGRAM_ADDRESS]] as const) {
    try {
      const r = await ctx.rpc.getTokenAccountsByOwner(owner, { programId }, { encoding: "jsonParsed" }).send();
      out.push({ program, rows: r.value as unknown as ParsedTokenAccount[] });
    } catch {
      out.push({ program, rows: [] });
    }
  }
  return out;
}

export { tokenAccounts };

/** All balances for `owner`: SOL plus every token account under both token programs, with USD values. */
export async function balances(ctx: Ctx, owner: Address, opts: { minValueUsd?: number; includeDust?: boolean } = {}): Promise<BalanceRow[]> {
  const lamports = (await ctx.rpc.getBalance(owner).send()).value;
  const perMint = new Map<string, { units: bigint; decimals: number; program: "token" | "token-2022" }>();
  for (const { program, rows } of await tokenAccounts(ctx, owner)) {
    for (const r of rows) {
      const info = r.account.data.parsed.info;
      const cur = perMint.get(info.mint) ?? { units: 0n, decimals: info.tokenAmount.decimals, program };
      cur.units += BigInt(info.tokenAmount.amount);
      perMint.set(info.mint, cur);
    }
  }
  const mints = [SOL_MINT, ...perMint.keys()];
  const px = await prices(ctx, mints);
  const unknownMints = [...perMint.keys()].filter((m) => !known(m));
  const symbols = new Map<string, string>();
  await Promise.all(
    unknownMints.slice(0, 25).map(async (m) => {
      const t = await jupiterTokenInfo(ctx, m).catch(() => null);
      if (t?.symbol) symbols.set(m, t.symbol);
    }),
  );
  const rows: BalanceRow[] = [];
  const push = (mint: string, units: bigint, decimals: number, program: BalanceRow["program"]) => {
    const bal = fromUnits(units, decimals);
    const p = px[mint];
    const value = p === null ? null : Number(bal) * p;
    rows.push({
      symbol: known(mint)?.symbol ?? symbols.get(mint) ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`,
      address: mint,
      binanceChainId: CHAIN_ID,
      balance: bal,
      decimals,
      price: p === null ? null : String(p),
      value: fmtUsd(value),
      program,
    });
  };
  push(SOL_MINT, BigInt(lamports), 9, "system");
  for (const [mint, v] of perMint) push(mint, v.units, v.decimals, v.program);
  const min = opts.minValueUsd ?? 0.01;
  return rows
    .filter((r) => opts.includeDust || r.program === "system" || r.value === null || Number(r.value) >= min)
    .sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0));
}

export interface TxLeg {
  binanceChainId: string;
  amount: string; // base units
  addressInfo: { address: string };
  tokenInfo: { binanceChainId: string; contractAddress: string; symbol: string; tokenId: null; decimals: number };
}

export interface TxRow {
  txType: "send" | "receive" | "swap" | "other" | "pending";
  txHash: string;
  txTime: string | null;
  binanceChainId: string;
  status: "confirmed" | "failed" | "pending";
  slot: number | null;
  explorer: string;
  memo: string | null;
  orderId?: string;
  txHashList: {
    binanceChainId: string;
    txHash: string;
    status: "confirmed" | "failed" | "pending";
    networkFee: { binanceChainId: string; feeTokenAddress: string; feeTokenSymbol: string; feeValue: string; feeTokenDecimals: number };
    instructions: { send: TxLeg[]; receive: TxLeg[] };
  }[];
}

interface ParsedTx {
  slot: bigint | number;
  blockTime: bigint | number | null;
  meta: {
    err: unknown;
    fee: bigint | number;
    preBalances: readonly (bigint | number)[];
    postBalances: readonly (bigint | number)[];
    preTokenBalances?: readonly { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }[] | null;
    postTokenBalances?: readonly { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string; decimals: number } }[] | null;
    logMessages?: readonly string[] | null;
  } | null;
  transaction: { message: { accountKeys: readonly { pubkey: string }[] } };
}

/** Turn a parsed transaction into send/receive legs from `owner`'s point of view. */
export function describeTx(sig: string, tx: ParsedTx, owner: string, symbolOf: (mint: string) => string): TxRow {
  const meta = tx.meta;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  const send: TxLeg[] = [];
  const receive: TxLeg[] = [];
  const leg = (mint: string, units: bigint, decimals: number, counterparty: string): TxLeg => ({
    binanceChainId: CHAIN_ID,
    amount: units.toString(),
    addressInfo: { address: counterparty },
    tokenInfo: { binanceChainId: CHAIN_ID, contractAddress: mint, symbol: symbolOf(mint), tokenId: null, decimals },
  });
  let memo: string | null = null;
  if (meta) {
    const idx = keys.indexOf(owner);
    if (idx >= 0) {
      let delta = BigInt(meta.postBalances[idx]) - BigInt(meta.preBalances[idx]);
      if (idx === 0) delta += BigInt(meta.fee); // the fee payer's fee is not a transfer
      if (delta !== 0n) {
        // counterparty: the account whose SOL moved the other way the most
        let best = "";
        let bestD = 0n;
        keys.forEach((k, i) => {
          if (i === idx) return;
          const d = BigInt(meta.postBalances[i]) - BigInt(meta.preBalances[i]);
          if ((delta < 0n && d > bestD) || (delta > 0n && d < bestD)) {
            best = k;
            bestD = d;
          }
        });
        (delta < 0n ? send : receive).push(leg(SOL_MINT, delta < 0n ? -delta : delta, 9, best));
      }
    }
    const pre = new Map<string, bigint>();
    const dec = new Map<string, number>();
    for (const b of meta.preTokenBalances ?? []) if (b.owner === owner) pre.set(b.mint, (pre.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount.amount));
    const post = new Map<string, bigint>();
    for (const b of meta.postTokenBalances ?? []) {
      dec.set(b.mint, b.uiTokenAmount.decimals);
      if (b.owner === owner) post.set(b.mint, (post.get(b.mint) ?? 0n) + BigInt(b.uiTokenAmount.amount));
    }
    for (const b of meta.preTokenBalances ?? []) dec.set(b.mint, b.uiTokenAmount.decimals);
    for (const mint of new Set([...pre.keys(), ...post.keys()])) {
      const d = (post.get(mint) ?? 0n) - (pre.get(mint) ?? 0n);
      if (d === 0n) continue;
      // counterparty: other owner of the same mint with the opposite delta
      const others = new Map<string, bigint>();
      for (const b of meta.preTokenBalances ?? []) if (b.mint === mint && b.owner && b.owner !== owner) others.set(b.owner, (others.get(b.owner) ?? 0n) - BigInt(b.uiTokenAmount.amount));
      for (const b of meta.postTokenBalances ?? []) if (b.mint === mint && b.owner && b.owner !== owner) others.set(b.owner, (others.get(b.owner) ?? 0n) + BigInt(b.uiTokenAmount.amount));
      let cp = "";
      let cpD = 0n;
      for (const [o, od] of others) if ((d < 0n && od > cpD) || (d > 0n && od < cpD)) (cp = o), (cpD = od);
      (d < 0n ? send : receive).push(leg(mint, d < 0n ? -d : d, dec.get(mint) ?? 0, cp));
    }
    const m = (meta.logMessages ?? []).find((l) => l.startsWith("Program log: Memo"));
    if (m) memo = m.replace(/^Program log: Memo \(len \d+\): /, "").replace(/^"|"$/g, "");
  }
  const failed = Boolean(meta?.err);
  const txType: TxRow["txType"] = send.length && receive.length ? "swap" : send.length ? "send" : receive.length ? "receive" : "other";
  const status = failed ? "failed" : "confirmed";
  return {
    txType,
    txHash: sig,
    txTime: tx.blockTime === null ? null : new Date(Number(tx.blockTime) * 1000).toISOString(),
    binanceChainId: CHAIN_ID,
    status,
    slot: Number(tx.slot),
    explorer: explorerUrl(sig),
    memo,
    txHashList: [
      {
        binanceChainId: CHAIN_ID,
        txHash: sig,
        status,
        networkFee: { binanceChainId: CHAIN_ID, feeTokenAddress: SOL_MINT, feeTokenSymbol: "SOL", feeValue: String(meta?.fee ?? 0), feeTokenDecimals: 9 },
        instructions: { send, receive },
      },
    ],
  };
}

export interface HistoryQuery {
  type?: "all" | "pending" | "confirmed";
  size?: number;
  nextCursor?: string;
  tx?: string;
  startTime?: number;
  endTime?: number;
}

export async function txHistory(ctx: Ctx, owner: Address, q: HistoryQuery): Promise<{ transactions: TxRow[]; hasMore: boolean; nextCursor: string | null }> {
  const symbolOf = (mint: string) => known(mint)?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`;
  const type = q.type ?? "all";
  const size = Math.min(Math.max(q.size ?? 20, 1), 100);
  const pending: TxRow[] = [];
  if (type !== "confirmed") {
    for (const o of await refreshPending(ctx)) {
      if (o.status !== "BROADCASTED" || !o.txHash) continue;
      pending.push({
        txType: "pending",
        txHash: o.txHash,
        txTime: new Date(o.createdAt).toISOString(),
        binanceChainId: CHAIN_ID,
        status: "pending",
        slot: null,
        explorer: explorerUrl(o.txHash),
        memo: o.summary,
        orderId: o.id,
        txHashList: [],
      });
    }
  }
  if (type === "pending") return { transactions: pending, hasMore: false, nextCursor: null };
  if (q.tx) {
    const tx = (await ctx.rpc.getTransaction(q.tx as Signature, { maxSupportedTransactionVersion: 1, encoding: "jsonParsed" }).send()) as unknown as ParsedTx | null;
    if (!tx) {
      const p = pending.find((x) => x.txHash === q.tx);
      return { transactions: p ? [p] : [], hasMore: false, nextCursor: null };
    }
    return { transactions: [describeTx(q.tx, tx, owner, symbolOf)], hasMore: false, nextCursor: null };
  }
  const sigs = await ctx.rpc.getSignaturesForAddress(owner, { limit: size + 1, ...(q.nextCursor ? { before: q.nextCursor as Signature } : {}) }).send();
  const page = sigs.slice(0, size);
  const rows: TxRow[] = [];
  for (const s of page) {
    const t = s.blockTime === null ? null : Number(s.blockTime) * 1000;
    if (t !== null && ((q.startTime && t < q.startTime) || (q.endTime && t > q.endTime))) continue;
    const tx = (await ctx.rpc.getTransaction(s.signature, { maxSupportedTransactionVersion: 1, encoding: "jsonParsed" }).send()) as unknown as ParsedTx | null;
    if (!tx) continue;
    const row = describeTx(s.signature, tx, owner, symbolOf);
    const o = orders.all().find((x) => x.txHash === s.signature);
    if (o) row.orderId = o.id;
    rows.push(row);
  }
  return { transactions: [...pending, ...rows], hasMore: sigs.length > size, nextCursor: sigs.length > size ? page[page.length - 1].signature : null };
}

export type GasLevel = "LOW" | "MEDIUM" | "HIGH";
export const DEFAULT_CU = 200_000;

export interface GasLevels {
  baseFeePerGas: null;
  low: GasTier;
  medium: GasTier;
  high: GasTier;
  unit: "micro-lamports per compute unit";
  assumedComputeUnits: number;
  baseFeeLamports: 5000;
}
export interface GasTier {
  gasPrice: string; // micro-lamports per CU
  maxFeePerGas: null;
  maxPriorityFeePerGas: null;
  tipAmount: string; // SOL for DEFAULT_CU
  waitTimeEstimate: null;
}

/** Priority-fee tiers from recent blocks: p25 / p50 / p90 of non-zero fees, with sane floors. */
export async function gasLevels(ctx: Ctx, accounts: Address[] = []): Promise<GasLevels> {
  const fees = (await ctx.rpc.getRecentPrioritizationFees(accounts.length ? accounts : undefined).send()).map((f) => Number(f.prioritizationFee)).filter((f) => f > 0).sort((a, b) => a - b);
  const pick = (p: number, floor: number) => (fees.length ? Math.max(floor, fees[Math.min(fees.length - 1, Math.floor(p * fees.length))]) : floor);
  const tier = (price: number): GasTier => ({ gasPrice: String(price), maxFeePerGas: null, maxPriorityFeePerGas: null, tipAmount: ((price * DEFAULT_CU) / 1e6 / 1e9).toFixed(9).replace(/0+$/, "").replace(/\.$/, ""), waitTimeEstimate: null });
  return { baseFeePerGas: null, low: tier(pick(0.25, 1000)), medium: tier(pick(0.5, 10_000)), high: tier(pick(0.9, 100_000)), unit: "micro-lamports per compute unit", assumedComputeUnits: DEFAULT_CU, baseFeeLamports: 5000 };
}

/** Total priority fee (lamports) to request for a transaction at a gas level, assuming DEFAULT_CU. */
export async function priorityFeeLamports(ctx: Ctx, level: GasLevel = "MEDIUM"): Promise<bigint> {
  const g = await gasLevels(ctx).catch(() => null);
  const price = Number(g?.[level.toLowerCase() as "low" | "medium" | "high"].gasPrice ?? { LOW: 1000, MEDIUM: 10_000, HIGH: 100_000 }[level]);
  return BigInt(Math.ceil((price * DEFAULT_CU) / 1e6));
}

export function asAddress(s: string): Address {
  return address(s);
}
