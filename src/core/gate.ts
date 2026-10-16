// The policy gate every state-changing action passes through:
//   quota check → risk reasons → (AutoReject | queue for owner confirmation) → lock check → execute → record.
import type { Ctx } from "./ctx.js";
import { WalletError } from "./errors.js";
import { readPolicy } from "./policy.js";
import { assertQuota, assertUnlocked, newOrder, orders, queueForConfirmation, setOrder, type Category, type OrderKind, type OrderStatus } from "./orders.js";
import { refreshPending } from "./track.js";

export interface Pending {
  orderId: string;
  status: "PENDING_CONFIRMATION";
  message: string;
  reasons: string[];
  expiresAt: number;
}

export interface Executed {
  txHash?: string | null;
  signedTx?: string;
  lastValidBlockHeight?: number;
  status?: OrderStatus;
  details?: Record<string, unknown>;
}

export interface GateInput<T> {
  /** Replaying an approved order: skip quota + risk, reuse the record. */
  orderId?: string;
  kind: OrderKind;
  category: Category;
  usd: number;
  summary: string;
  details: Record<string, unknown>;
  command: string;
  params: Record<string, unknown>;
  reasons: string[];
  /** Some actions never need the lock (e.g. placing a resting order off-chain). Default true. */
  needsLock?: boolean;
  execute: () => Promise<Executed & { result: T }>;
}

export function isPending(x: unknown): x is Pending {
  return typeof x === "object" && x !== null && (x as Pending).status === "PENDING_CONFIRMATION";
}

export async function gated<T>(ctx: Ctx, g: GateInput<T>): Promise<T | Pending> {
  const replay = Boolean(g.orderId && ctx.approved);
  if (g.needsLock !== false) await refreshPending(ctx); // settle anything that already landed before judging the lock
  if (!replay) {
    assertQuota(g.category, g.usd);
    if (g.reasons.length) {
      const p = readPolicy();
      if (p.abnormalTxnHandling === "AutoReject") {
        throw new WalletError("RISK_BLOCKED", `Blocked by policy (abnormalTxnHandling=AutoReject): ${g.reasons.join("; ")}.`, { reasons: g.reasons });
      }
      if (g.needsLock !== false) assertUnlocked();
      const o = queueForConfirmation({ kind: g.kind, category: g.category, usdValue: g.usd, summary: g.summary, details: g.details }, { command: g.command, params: g.params }, g.reasons);
      return {
        orderId: o.id,
        status: "PENDING_CONFIRMATION",
        message: `Waiting for the owner to confirm (${g.reasons.join("; ")}). The owner approves with \`saw owner approve ${o.id}\` or in the vault UI within 5 minutes. Check with \`wallet tx-lock\`.`,
        reasons: g.reasons,
        expiresAt: o.expiresAt!,
      };
    }
  }
  if (g.needsLock !== false) assertUnlocked(g.orderId);
  const order = replay && g.orderId && orders.get(g.orderId)
    ? setOrder(g.orderId, { status: "BROADCASTED", action: undefined, summary: g.summary, details: { ...orders.get(g.orderId)!.details, ...g.details } })
    : newOrder({ kind: g.kind, category: g.category, status: "BROADCASTED", usdValue: g.usd, summary: g.summary, details: g.details, reasons: g.reasons });
  try {
    const r = await g.execute();
    setOrder(order.id, {
      status: r.status ?? "BROADCASTED",
      txHash: r.txHash ?? null,
      signedTx: r.signedTx,
      lastValidBlockHeight: r.lastValidBlockHeight,
      details: { ...order.details, ...(r.details ?? {}) },
    });
    const result = r.result as T & { orderId?: string };
    if (result && typeof result === "object" && !Array.isArray(result) && !(result as { orderId?: string }).orderId) (result as { orderId?: string }).orderId = order.id;
    return result;
  } catch (e) {
    setOrder(order.id, { status: "FAILED", error: (e as Error).message });
    throw e;
  }
}
