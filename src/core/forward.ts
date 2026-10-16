// Pass-through execution on a forwarding backend (Binance). Writes still cross this control plane's gate:
// quota, lock, risk reasons and owner confirmation apply before the command reaches `baw`.
import type { Ctx } from "./ctx.js";
import type { Command } from "./registry.js";
import { activeBackend } from "./backend.js";
import { gated, isPending } from "./gate.js";
import { price } from "./prices.js";
import { knownBySymbol, resolveToken } from "./tokens.js";
import { readPolicy } from "./policy.js";
import { assertTokenAllowed } from "./send.js";

/** Best-effort USD estimate from the common parameter shapes (amount + tokenAddress, fromTokenQty + fromToken). */
export async function estimateUsd(ctx: Ctx, params: Record<string, unknown>): Promise<number> {
  const qty = Number(params.amount ?? params.fromTokenQty ?? params.quantity ?? 0);
  const tok = (params.tokenAddress ?? params.fromToken) as string | undefined;
  if (!qty || !tok) return 0;
  try {
    const t = await resolveToken(ctx, tok);
    const p = await price(ctx, t.mint);
    return p === null ? 0 : qty * p;
  } catch {
    return 0;
  }
}

export async function forwarded(ctx: Ctx, cmd: Command, args: Record<string, unknown>): Promise<unknown> {
  const be = activeBackend();
  if (!be.forward) throw new Error("backend cannot forward");
  const params = { ...args };
  delete params.orderId;
  if (!cmd.write) return be.forward(ctx, cmd.cli, params);
  const policy = readPolicy();
  for (const k of ["tokenAddress", "fromToken", "toToken"]) if (typeof params[k] === "string") assertTokenAllowed(policy, knownBySymbol(params[k] as string) ?? (params[k] as string));
  const usd = await estimateUsd(ctx, params);
  const r = await gated(ctx, {
    orderId: args.orderId as string | undefined,
    kind: cmd.category === "defi" ? "defi" : cmd.category === "prediction" ? "prediction" : cmd.category === "x402" ? "x402" : cmd.name.startsWith("limit-order") ? "limit" : cmd.name.startsWith("market-order") ? "swap" : cmd.name.startsWith("sign-message") ? "sign-message" : cmd.name.startsWith("contract-call") ? "contract-call" : cmd.name.startsWith("approvals") ? "revoke" : "send",
    category: cmd.category ?? "general",
    usd,
    summary: `${be.kind}: ${cmd.cli} ${Object.entries(params).map(([k, v]) => `${k}=${String(v)}`).join(" ")}`.slice(0, 160),
    details: { forwardedTo: be.kind, command: cmd.cli, params, amountUsd: Number(usd.toFixed(2)) },
    command: cmd.name,
    params,
    reasons: [],
    needsLock: false,
    async execute() {
      const data = (await be.forward!(ctx, cmd.cli, params)) as Record<string, unknown> | null;
      const txHash = (data && typeof data === "object" && (data.txHash as string | undefined)) || null;
      return { txHash, status: txHash ? "BROADCASTED" : "COMPLETED", result: data };
    },
  });
  if (isPending(r)) return { status: "PENDING_CONFIRMATION", orderId: r.orderId, message: r.message };
  return r;
}
