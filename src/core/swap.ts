// Market orders = Jupiter swaps. quote → (policy, audit) → build swap tx → sign → broadcast → track.
import type { Ctx } from "./ctx.js";
import { jup, slippageBps, type QuoteResponse, type SwapResponse } from "./jupiter.js";
import { fromUnits, resolveToken, toUnits, type TokenRef } from "./tokens.js";
import { readPolicy } from "./policy.js";
import { assertTokenAllowed } from "./send.js";
import { usdValue } from "./prices.js";
import { auditToken, assessTransfer } from "./risk.js";
import { loadSigner } from "./signer.js";
import { WalletError } from "./errors.js";
import { orders, type Order } from "./orders.js";
import { CHAIN_ID } from "./config.js";
import type { GasLevel } from "./view.js";

export interface SwapArgs {
  fromTokenQty: string;
  fromToken: string;
  toToken: string;
  slippage?: string;
  mev?: boolean;
  gasLevel?: GasLevel;
}

export interface PreparedSwap {
  from: TokenRef;
  to: TokenRef;
  units: bigint;
  quote: QuoteResponse;
  usd: number;
  priced: boolean;
  reasons: string[];
  slippageBps: number | undefined;
  view: ReturnType<typeof quoteView>;
}

export function quoteView(from: TokenRef, to: TokenRef, q: QuoteResponse) {
  return {
    fromCoinSymbol: from.symbol,
    fromCoinAddress: from.mint,
    fromCoinAmount: fromUnits(BigInt(q.inAmount), from.decimals),
    toCoinSymbol: to.symbol,
    toCoinAddress: to.mint,
    toCoinAmount: fromUnits(BigInt(q.outAmount), to.decimals),
    minimumReceived: fromUnits(BigInt(q.otherAmountThreshold), to.decimals),
    slippage: q.slippageBps / 10_000,
    priceImpactPct: q.priceImpactPct,
    route: q.routePlan.map((r) => r.swapInfo.label ?? r.swapInfo.ammKey),
    binanceChainId: CHAIN_ID,
  };
}

export async function getQuote(ctx: Ctx, a: SwapArgs): Promise<{ from: TokenRef; to: TokenRef; units: bigint; quote: QuoteResponse }> {
  const from = await resolveToken(ctx, a.fromToken);
  const to = await resolveToken(ctx, a.toToken);
  if (from.mint === to.mint) throw new WalletError("INVALID_PARAM", "fromToken and toToken are the same.");
  const units = toUnits(a.fromTokenQty, from.decimals);
  const bps = slippageBps(a.slippage);
  const quote = await jup<QuoteResponse>(ctx, "/swap/v1/quote", {
    query: { inputMint: from.mint, outputMint: to.mint, amount: units.toString(), slippageBps: bps ?? 50, restrictIntermediateTokens: true, ...(bps === undefined ? { dynamicSlippage: true } : {}) },
  });
  return { from, to, units, quote };
}

export async function prepareSwap(ctx: Ctx, a: SwapArgs): Promise<PreparedSwap> {
  const policy = readPolicy();
  assertTokenAllowed(policy, a.fromToken);
  assertTokenAllowed(policy, a.toToken);
  const { from, to, units, quote } = await getQuote(ctx, a);
  const amount = fromUnits(units, from.decimals);
  const { usd, priced } = await usdValue(ctx, from.mint, amount, from.symbol);
  if (policy.maxPaymentUsd !== null && usd > policy.maxPaymentUsd) {
    throw new WalletError("PAYMENT_LIMIT_EXCEEDED", `$${usd.toFixed(2)} is above the per-transaction limit of $${policy.maxPaymentUsd} (policy.maxPaymentUsd).`);
  }
  const audit = await auditToken(ctx, to.mint);
  const { reasons } = assessTransfer({ usd, priced, recipientKnown: null, tokenAudit: audit });
  if (Number(quote.priceImpactPct) > 0.05) reasons.push(`price impact ${(Number(quote.priceImpactPct) * 100).toFixed(2)}% is above 5%`);
  return { from, to, units, quote, usd, priced, reasons, slippageBps: slippageBps(a.slippage), view: quoteView(from, to, quote) };
}

export async function buildSwapTx(ctx: Ctx, p: PreparedSwap, a: SwapArgs): Promise<SwapResponse> {
  const signer = await loadSigner();
  const level = (a.gasLevel ?? "MEDIUM").toLowerCase();
  const jito = a.mev !== false && process.env.JITO_TIP_LAMPORTS ? Number(process.env.JITO_TIP_LAMPORTS) : undefined;
  const body = {
    quoteResponse: p.quote,
    userPublicKey: signer.address,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    dynamicSlippage: p.slippageBps === undefined,
    prioritizationFeeLamports: jito
      ? { jitoTipLamports: jito }
      : { priorityLevelWithMaxLamports: { maxLamports: 2_000_000, priorityLevel: level === "low" ? "medium" : level === "high" ? "veryHigh" : "high" } },
  };
  const r = await jup<SwapResponse>(ctx, "/swap/v1/swap", { body });
  if (r.simulationError?.error) throw new WalletError("SIMULATION_FAILED", `Jupiter simulation failed: ${r.simulationError.error}`);
  return r;
}

export type MarketStatus = "PENDING" | "FINISHED" | "FAILED";

export function marketStatus(o: Order): MarketStatus {
  if (o.status === "CONFIRMED" || o.status === "FINISHED" || o.status === "COMPLETED") return "FINISHED";
  if (o.status === "FAILED" || o.status === "REJECTED" || o.status === "EXPIRED" || o.status === "CANCELED") return "FAILED";
  return "PENDING";
}

export function marketRow(o: Order) {
  const d = o.details as Record<string, string>;
  return {
    orderType: "market",
    orderId: o.id,
    chain: CHAIN_ID,
    fromToken: d.fromCoinAddress,
    fromTokenName: d.fromCoinSymbol,
    fromTokenQty: d.fromCoinAmount,
    toToken: d.toCoinAddress,
    toTokenName: d.toCoinSymbol,
    toTokenQty: d.toCoinAmount,
    status: marketStatus(o),
    slippage: d.slippage,
    txHash: o.txHash,
    bookTime: new Date(o.createdAt).toISOString(),
    updatedTime: new Date(o.updatedAt).toISOString(),
    error: o.error ?? null,
  };
}

export function marketOrders(filter: { orderId?: string; status?: MarketStatus; fromToken?: string; toToken?: string; startTime?: number; endTime?: number }) {
  let list = orders.all().filter((o) => o.kind === "swap");
  if (filter.orderId) list = list.filter((o) => o.id === filter.orderId);
  else {
    if (filter.status) list = list.filter((o) => marketStatus(o) === filter.status);
    if (filter.fromToken) list = list.filter((o) => (o.details as Record<string, string>).fromCoinAddress === filter.fromToken);
    if (filter.toToken) list = list.filter((o) => (o.details as Record<string, string>).toCoinAddress === filter.toToken);
    if (filter.startTime) list = list.filter((o) => o.createdAt >= filter.startTime!);
    if (filter.endTime) list = list.filter((o) => o.createdAt <= filter.endTime!);
  }
  return list.sort((a, b) => b.createdAt - a.createdAt).map(marketRow);
}
