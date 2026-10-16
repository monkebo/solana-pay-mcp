// Every state-changing action is an order: queued for confirmation, broadcast, confirmed, failed...
// Quotas, the transaction lock and the owner's confirmation queue are all views over this one collection.
import { randomUUID } from "node:crypto";
import { Collection } from "./store.js";
import { WalletError } from "./errors.js";
import { readPolicy, type Policy } from "./policy.js";

export type Category = "general" | "x402";
export type OrderKind = "send" | "revoke" | "x402" | "speed-up" | "cancel";
export type OrderStatus =
  | "PENDING_CONFIRMATION" | "REJECTED" | "EXPIRED"
  | "BROADCASTED" | "CONFIRMED" | "FAILED" | "COMPLETED"
  | "PENDING" | "FINISHED" | "WORKING" | "TRIGGERED" | "CANCELED";

export const TERMINAL: OrderStatus[] = ["REJECTED", "EXPIRED", "CONFIRMED", "FAILED", "COMPLETED", "FINISHED", "CANCELED"];
const NOT_COUNTED: OrderStatus[] = ["REJECTED", "EXPIRED", "FAILED", "CANCELED"];

export interface Action {
  command: string;
  params: Record<string, unknown>;
}

export interface Order {
  id: string;
  kind: OrderKind;
  category: Category;
  status: OrderStatus;
  /** USD value counted against the category quota (null = unknown / zero). */
  usdValue: number | null;
  summary: string;
  createdAt: number;
  updatedAt: number;
  txHash: string | null;
  /** Set while PENDING_CONFIRMATION: what to run when the owner approves. */
  action?: Action;
  expiresAt?: number;
  /** Base64 signed transaction kept for `wallet speed-up` (rebroadcast) while the blockhash is valid. */
  signedTx?: string;
  lastValidBlockHeight?: number;
  /** Why confirmation was required / why it was blocked. */
  reasons?: string[];
  /** Which wallet executed it. */
  backend?: string;
  details: Record<string, unknown>;
  error?: string;
}

export const orders = new Collection<Order>("orders");

export function newOrder(o: Omit<Order, "id" | "createdAt" | "updatedAt" | "txHash" | "details"> & Partial<Pick<Order, "txHash" | "details" | "id">>): Order {
  const now = Date.now();
  return orders.put({ txHash: null, details: {}, ...o, id: o.id ?? `ord_${randomUUID().slice(0, 12)}`, createdAt: now, updatedAt: now });
}

export function setOrder(id: string, patch: Partial<Order>): Order {
  return orders.update(id, { ...patch, updatedAt: Date.now() });
}

/** Sweep PENDING_CONFIRMATION orders past their expiry. */
export function expireStale(): void {
  const now = Date.now();
  for (const o of orders.all()) {
    if (o.status === "PENDING_CONFIRMATION" && o.expiresAt !== undefined && o.expiresAt < now) setOrder(o.id, { status: "EXPIRED", action: undefined });
  }
}

const DAY = 24 * 3600 * 1000;

/** USD spent in a category in the last 24h. Counted at submission, like the Binance quotas. */
export function quotaUsed(category: Category, now = Date.now()): number {
  return orders
    .all()
    .filter((o) => o.category === category && !NOT_COUNTED.includes(o.status) && o.createdAt >= now - DAY)
    .reduce((a, o) => a + (o.usdValue ?? 0), 0);
}

export function quotaLimit(p: Policy, category: Category): number {
  switch (category) {
    case "general":
      return p.dailyLimitUsd;
    case "x402":
      return p.x402DailyLimitUsd;
  }
}

export function quotaView(p: Policy, category: Category) {
  const used = round2(quotaUsed(category));
  const limit = quotaLimit(p, category);
  return { used, left: round2(Math.max(0, limit - used)), limit, date: new Date().toISOString().slice(0, 10) };
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Throws DAILY_LIMIT_EXCEEDED when `usd` would push the category over its limit. */
export function assertQuota(category: Category, usd: number, p = readPolicy()): void {
  const limit = quotaLimit(p, category);
  const used = quotaUsed(category);
  if (used + usd > limit + 1e-9) {
    throw new WalletError(
      "DAILY_LIMIT_EXCEEDED",
      `${category} daily limit exceeded: limit $${limit}, used $${round2(used)} in the last 24h, requested $${round2(usd)}. The owner can raise it with \`saw owner set-policy\`.`,
      { category, limit, used: round2(used), requested: round2(usd) },
    );
  }
}

/** Orders that hold the transaction lock: awaiting owner confirmation, or broadcast but not yet confirmed. */
export function lockingOrders(): Order[] {
  expireStale();
  return orders.all().filter((o) => o.status === "PENDING_CONFIRMATION" || o.status === "BROADCASTED");
}

export function assertUnlocked(exceptId?: string): void {
  const l = lockingOrders().filter((o) => o.id !== exceptId);
  if (l.length) {
    const o = l[0];
    throw new WalletError(
      "LOCKED",
      o.status === "PENDING_CONFIRMATION"
        ? `Wallet is locked: order ${o.id} is waiting for the owner to confirm (${o.summary}). Run \`wallet tx-lock\` to check, or ask the owner to approve/reject it.`
        : `Wallet is locked: transaction ${o.txHash} (${o.summary}) is still pending on-chain. Re-check with \`wallet tx-lock\` in a moment.`,
      { orderId: o.id, status: o.status, txHash: o.txHash },
    );
  }
}

/** Queue an action for owner confirmation. 5 minute window, like the Binance App double-confirm. */
export function queueForConfirmation(o: Omit<Parameters<typeof newOrder>[0], "status">, action: Action, reasons: string[]): Order {
  return newOrder({ ...o, status: "PENDING_CONFIRMATION", action, reasons, expiresAt: Date.now() + 5 * 60 * 1000 });
}

export function pendingConfirmations(): Order[] {
  expireStale();
  return orders.all().filter((o) => o.status === "PENDING_CONFIRMATION");
}
