// Broadcast ≠ confirmed. Orders go BROADCASTED → CONFIRMED | FAILED by polling signature statuses.
import { type Signature } from "@solana/kit";
import type { Ctx } from "./ctx.js";
import { orders, setOrder, type Order } from "./orders.js";

export async function refreshPending(ctx: Ctx): Promise<Order[]> {
  const pending = orders.all().filter((o) => o.status === "BROADCASTED" && o.txHash);
  if (!pending.length) return [];
  const sigs = pending.map((o) => o.txHash as Signature);
  let statuses: readonly (null | { err: unknown; confirmationStatus: string | null })[] = [];
  try {
    statuses = (await ctx.rpc.getSignatureStatuses(sigs, { searchTransactionHistory: true }).send()).value as never;
  } catch {
    return pending; // RPC hiccup: leave as is
  }
  let height: bigint | undefined;
  const out: Order[] = [];
  for (let i = 0; i < pending.length; i++) {
    const o = pending[i];
    const s = statuses[i];
    if (s) {
      if (s.err) out.push(setOrder(o.id, { status: "FAILED", error: JSON.stringify(s.err), signedTx: undefined }));
      else if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") out.push(setOrder(o.id, { status: "CONFIRMED", signedTx: undefined }));
      else out.push(o);
      continue;
    }
    // Unknown to the cluster: dropped once its blockhash expired.
    if (o.lastValidBlockHeight !== undefined) {
      if (height === undefined) {
        try {
          height = await ctx.rpc.getBlockHeight().send();
        } catch {
          height = 0n;
        }
      }
      if (height > BigInt(o.lastValidBlockHeight)) {
        out.push(setOrder(o.id, { status: "FAILED", error: "dropped: blockhash expired before the transaction landed", signedTx: undefined }));
        continue;
      }
    }
    out.push(o);
  }
  return out;
}

/** Wait up to `ms` for a signature to confirm. Returns the final status or null if still unknown. */
export async function awaitSignature(ctx: Ctx, sig: string, ms = 30_000): Promise<"confirmed" | "failed" | null> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const [s] = (await ctx.rpc.getSignatureStatuses([sig as Signature]).send()).value;
      if (s) {
        if (s.err) return "failed";
        if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return "confirmed";
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
