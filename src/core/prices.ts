// USD prices from Jupiter Price v3, cached 30s. Stablecoins fall back to $1 when the API is unreachable,
// everything else to null, and the policy decides whether an unpriced token may move (default: no).
import type { Ctx } from "./ctx.js";
import { jupiterBase } from "./config.js";
import { jupHeaders, STABLE_MINTS, SOL_MINT, USDC_MINT } from "./tokens.js";
import { WalletError } from "./errors.js";
import { readPolicy } from "./policy.js";

const TTL = 30_000;
const cache = new Map<string, { at: number; usd: number | null }>();

export async function prices(ctx: Ctx, mints: string[]): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  const now = Date.now();
  // devnet USDC has no market; price it as the mainnet dollar.
  const query = [...new Set(mints.map((m) => (m === USDC_MINT.devnet ? USDC_MINT.mainnet : m)))].filter((m) => !(cache.get(m) && now - cache.get(m)!.at < TTL));
  if (query.length) {
    try {
      const r = await ctx.fetch(`${jupiterBase()}/price/v3?ids=${query.join(",")}`, { headers: jupHeaders(), signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`price api ${r.status}`);
      const body = (await r.json()) as Record<string, { usdPrice?: number } | null>;
      for (const m of query) cache.set(m, { at: now, usd: typeof body[m]?.usdPrice === "number" ? body[m]!.usdPrice! : null });
    } catch {
      for (const m of query) cache.set(m, { at: now - TTL + 5000, usd: STABLE_MINTS.has(m) ? 1 : null });
    }
  }
  for (const m of mints) out[m] = cache.get(m === USDC_MINT.devnet ? USDC_MINT.mainnet : m)?.usd ?? (STABLE_MINTS.has(m) ? 1 : null);
  return out;
}

export async function price(ctx: Ctx, mint: string): Promise<number | null> {
  return (await prices(ctx, [mint]))[mint];
}

export async function solPrice(ctx: Ctx): Promise<number | null> {
  return price(ctx, SOL_MINT);
}

/**
 * USD value of a decimal token amount, for quota accounting. Throws PRICE_UNAVAILABLE for unpriced
 * tokens unless policy.allowUnpricedTokens (then counts as 0 and the caller should warn).
 */
export async function usdValue(ctx: Ctx, mint: string, amount: string, symbol = mint): Promise<{ usd: number; priced: boolean }> {
  const p = await price(ctx, mint);
  if (p === null) {
    if (readPolicy().allowUnpricedTokens) return { usd: 0, priced: false };
    throw new WalletError("PRICE_UNAVAILABLE", `No USD price for ${symbol} (${mint}); the daily limit cannot be enforced. The owner can set policy.allowUnpricedTokens=true to allow unpriced tokens (they count as $0).`);
  }
  return { usd: Number(amount) * p, priced: true };
}

export function fmtUsd(n: number | null): string | null {
  if (n === null) return null;
  return n < 0.01 && n > 0 ? String(n) : n.toFixed(2);
}
