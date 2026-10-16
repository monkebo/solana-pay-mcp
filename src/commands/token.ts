// Token lookup and audit (the `query-token-info` / `query-token-audit` skills, built in).
import { define, optNum, str } from "../core/registry.js";
import { jupiterBase } from "../core/config.js";
import { jupHeaders, resolveToken, type JupToken } from "../core/tokens.js";
import { auditToken } from "../core/risk.js";
import { WalletError } from "../core/errors.js";

define({
  name: "token.search",
  cli: "token search",
  title: "Search tokens",
  description: "Find tokens by symbol, name or mint via Jupiter. Always show the full mint address next to a symbol; never pick a token by name alone.",
  access: "public",
  write: false,
  params: { query: str("Symbol, name or mint"), limit: optNum("Max results (default 10)") },
  async run(ctx, { query, limit }) {
    const r = await ctx.fetch(`${jupiterBase()}/tokens/v2/search?query=${encodeURIComponent(query)}`, { headers: jupHeaders(), signal: AbortSignal.timeout(8000) }).catch((e: Error) => {
      throw new WalletError("UPSTREAM_UNAVAILABLE", `Jupiter token search unreachable: ${e.message}`);
    });
    if (!r.ok) throw new WalletError("UPSTREAM_ERROR", `Jupiter token search ${r.status}`);
    const list = (await r.json()) as JupToken[];
    return list.slice(0, limit ?? 10).map((t) => ({ mint: t.id, symbol: t.symbol, name: t.name, decimals: t.decimals, verified: t.isVerified ?? t.tags?.includes("verified") ?? false, usdPrice: t.usdPrice ?? null, liquidity: t.liquidity ?? null, mcap: t.mcap ?? null, organicScore: t.organicScore ?? null, tags: t.tags ?? [] }));
  },
});

define({
  name: "token.audit",
  cli: "token audit",
  title: "Token security audit",
  description: "Risk flags for a token before trading it: verification, mint/freeze authority, holder concentration, liquidity, organic score. hasResult=false means no data; do not infer safety from that.",
  access: "public",
  write: false,
  params: { tokenAddress: str("Mint or SOL/USDC/USDT") },
  async run(ctx, { tokenAddress }) {
    const t = await resolveToken(ctx, tokenAddress).catch(() => null);
    return auditToken(ctx, t?.mint ?? tokenAddress);
  },
});
