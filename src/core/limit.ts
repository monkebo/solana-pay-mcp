// Limit orders = Jupiter Trigger orders (on-chain resting orders filled by keepers when the price is reached).
import type { Ctx } from "./ctx.js";
import { jup, type TriggerOrder } from "./jupiter.js";
import { fromUnits, knownBySymbol, resolveToken, toUnits, known, STABLE_MINTS, SOL_MINT, type TokenRef } from "./tokens.js";
import { readPolicy } from "./policy.js";
import { assertTokenAllowed } from "./send.js";
import { price, usdValue } from "./prices.js";
import { auditToken, assessTransfer } from "./risk.js";
import { walletAddress } from "./signer.js";
import { WalletError } from "./errors.js";
import { orders, type Order } from "./orders.js";
import { CHAIN_ID } from "./config.js";

export type LimitStatus = "WORKING" | "TRIGGERED" | "PENDING" | "FINISHED" | "FAILED" | "EXPIRED" | "CANCELED";

export interface LimitArgs {
  side: "BUY" | "SELL";
  triggerPrice: string;
  fromTokenQty: string;
  fromToken: string;
  toToken: string;
  slippage?: string;
  expiredAt?: number;
}

export interface PreparedLimit {
  from: TokenRef;
  to: TokenRef;
  makingAmount: bigint;
  takingAmount: bigint;
  usd: number;
  reasons: string[];
  triggerPrice: number;
}

function isQuoteAsset(mint: string): boolean {
  return STABLE_MINTS.has(mint) || mint === SOL_MINT;
}

/** Translate a USD trigger price into Jupiter making/taking amounts. */
export async function prepareLimit(ctx: Ctx, a: LimitArgs): Promise<PreparedLimit> {
  const policy = readPolicy();
  assertTokenAllowed(policy, a.fromToken);
  assertTokenAllowed(policy, a.toToken);
  const trigger = Number(a.triggerPrice);
  if (!(trigger > 0)) throw new WalletError("INVALID_PARAM", "triggerPrice must be a positive USD price.");
  if (a.side === "BUY" && !isQuoteAsset(knownBySymbol(a.fromToken) ?? a.fromToken)) throw new WalletError("INVALID_PARAM", "limit-order buy: fromToken must be USDC, USDT or SOL.");
  if (a.side === "SELL" && !isQuoteAsset(knownBySymbol(a.toToken) ?? a.toToken)) throw new WalletError("INVALID_PARAM", "limit-order sell: toToken must be USDC, USDT or SOL.");
  const from = await resolveToken(ctx, a.fromToken);
  const to = await resolveToken(ctx, a.toToken);
  const makingAmount = toUnits(a.fromTokenQty, from.decimals);
  const fromQty = Number(fromUnits(makingAmount, from.decimals));
  // USD price of the quote-side asset (1 for stables, live for SOL).
  const quoteMint = a.side === "BUY" ? from.mint : to.mint;
  const quoteUsd = STABLE_MINTS.has(quoteMint) ? 1 : await price(ctx, quoteMint);
  if (quoteUsd === null) throw new WalletError("PRICE_UNAVAILABLE", "Cannot price SOL right now; try again or quote in USDC.");
  const takingQty = a.side === "BUY" ? (fromQty * quoteUsd) / trigger : (fromQty * trigger) / quoteUsd;
  const takingAmount = toUnits(takingQty.toFixed(to.decimals), to.decimals);
  if (takingAmount <= 0n) throw new WalletError("INVALID_PARAM", "Order too small: taking amount rounds to zero.");
  const { usd, priced } = await usdValue(ctx, from.mint, fromUnits(makingAmount, from.decimals), from.symbol);
  if (usd < 5) throw new WalletError("INVALID_PARAM", `Jupiter trigger orders need at least $5 of input; this order is $${usd.toFixed(2)}.`);
  if (policy.maxPaymentUsd !== null && usd > policy.maxPaymentUsd) throw new WalletError("PAYMENT_LIMIT_EXCEEDED", `$${usd.toFixed(2)} is above the per-transaction limit of $${policy.maxPaymentUsd}.`);
  const target = a.side === "BUY" ? to.mint : from.mint;
  const audit = await auditToken(ctx, target);
  const { reasons } = assessTransfer({ usd, priced, recipientKnown: null, tokenAudit: audit });
  return { from, to, makingAmount, takingAmount, usd, reasons, triggerPrice: trigger };
}

export async function createTriggerOrder(ctx: Ctx, p: PreparedLimit, a: LimitArgs): Promise<{ requestId: string; transaction: string; order: string }> {
  const maker = await walletAddress();
  return jup(ctx, "/trigger/v1/createOrder", {
    body: {
      inputMint: p.from.mint,
      outputMint: p.to.mint,
      maker,
      payer: maker,
      params: {
        makingAmount: p.makingAmount.toString(),
        takingAmount: p.takingAmount.toString(),
        ...(a.expiredAt ? { expiredAt: String(Math.floor(a.expiredAt / 1000)) } : {}),
        ...(a.slippage && a.slippage !== "auto" ? { slippageBps: String(Math.round(Number(a.slippage) * 100)) } : {}),
      },
      computeUnitPrice: "auto",
    },
  });
}

export async function executeTrigger(ctx: Ctx, requestId: string, signedTransaction: string): Promise<{ signature: string; status: string; error?: string }> {
  const r = await jup<{ signature?: string; status?: string; error?: string; code?: number }>(ctx, "/trigger/v1/execute", { body: { requestId, signedTransaction } });
  if (r.status && r.status !== "Success" && r.status !== "success") throw new WalletError("BROADCAST_FAILED", `Jupiter trigger execute: ${r.error ?? r.status}`, r);
  return { signature: r.signature ?? "", status: r.status ?? "Success", error: r.error };
}

export async function cancelTriggerTx(ctx: Ctx, orderKey: string): Promise<{ requestId: string; transaction: string }> {
  return jup(ctx, "/trigger/v1/cancelOrder", { body: { maker: await walletAddress(), order: orderKey, computeUnitPrice: "auto" } });
}

export async function fetchTriggerOrders(ctx: Ctx, status: "active" | "history", page = 1): Promise<TriggerOrder[]> {
  const r = await jup<{ orders?: TriggerOrder[] }>(ctx, "/trigger/v1/getTriggerOrders", { query: { user: await walletAddress(), orderStatus: status, page } });
  return r.orders ?? [];
}

export function limitStatusFromUpstream(o: TriggerOrder): LimitStatus {
  const s = (o.status ?? "").toLowerCase();
  if (s.includes("cancel")) return "CANCELED";
  if (s.includes("expir")) return "EXPIRED";
  if (s.includes("complet") || s.includes("fill")) return "FINISHED";
  if (s.includes("fail")) return "FAILED";
  return "WORKING";
}

export function limitRowFromLocal(o: Order) {
  const d = o.details as Record<string, string>;
  const map: Record<string, LimitStatus> = { WORKING: "WORKING", TRIGGERED: "TRIGGERED", BROADCASTED: "PENDING", PENDING: "PENDING", CONFIRMED: "WORKING", FINISHED: "FINISHED", COMPLETED: "FINISHED", FAILED: "FAILED", EXPIRED: "EXPIRED", CANCELED: "CANCELED", REJECTED: "FAILED", PENDING_CONFIRMATION: "PENDING" };
  return {
    orderType: "limit",
    strategyId: d.strategyId ?? o.id,
    orderId: o.id,
    chain: CHAIN_ID,
    side: d.side,
    fromToken: d.fromToken,
    fromTokenName: d.fromTokenName,
    fromTokenQty: d.fromTokenQty,
    toToken: d.toToken,
    toTokenName: d.toTokenName,
    toTokenQty: d.toTokenQty,
    triggerPrice: d.triggerPrice,
    status: map[o.status] ?? "WORKING",
    slippage: d.slippage ?? "auto",
    txHash: o.txHash,
    bookTime: new Date(o.createdAt).toISOString(),
    updatedTime: new Date(o.updatedAt).toISOString(),
    error: o.error ?? null,
  };
}

export function symbolFor(mint: string): string {
  return known(mint)?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

export { knownBySymbol };
