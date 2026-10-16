// Jupiter HTTP client: swap quotes and transactions, trigger (limit) orders, prices, token search, lend.
import type { Ctx } from "./ctx.js";
import { jupiterBase } from "./config.js";
import { jupHeaders } from "./tokens.js";
import { WalletError } from "./errors.js";

export async function jup<T>(ctx: Ctx, path: string, init: { method?: "GET" | "POST"; body?: unknown; query?: Record<string, string | number | boolean | undefined> } = {}): Promise<T> {
  const q = init.query ? "?" + Object.entries(init.query).filter(([, v]) => v !== undefined).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&") : "";
  const url = `${jupiterBase()}${path}${q}`;
  let r: Response;
  try {
    r = await ctx.fetch(url, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: { ...jupHeaders(), ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(Number(process.env.JUPITER_TIMEOUT_MS ?? 20_000)),
    });
  } catch (e) {
    throw new WalletError("UPSTREAM_UNAVAILABLE", `Jupiter API unreachable (${path}): ${(e as Error).message}`);
  }
  const text = await r.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!r.ok) {
    const b = body as { error?: string; message?: string; errorCode?: string };
    throw new WalletError("UPSTREAM_ERROR", `Jupiter ${path} returned ${r.status}: ${b.error ?? b.message ?? text.slice(0, 200)}`, { status: r.status, body });
  }
  return body as T;
}

export interface QuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: { swapInfo: { label?: string; ammKey: string; inputMint: string; outputMint: string; inAmount: string; outAmount: string; feeAmount: string; feeMint: string }; percent: number }[];
  contextSlot?: number;
  swapUsdValue?: string;
}

export interface SwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
  prioritizationFeeLamports?: number;
  computeUnitLimit?: number;
  dynamicSlippageReport?: { slippageBps?: number } | null;
  simulationError?: { error?: string; errorCode?: string } | null;
}

export interface TriggerOrder {
  userPubkey: string;
  orderKey: string;
  inputMint: string;
  outputMint: string;
  makingAmount: string;
  takingAmount: string;
  remainingMakingAmount: string;
  remainingTakingAmount: string;
  rawMakingAmount?: string;
  rawTakingAmount?: string;
  expiredAt: string | null;
  createdAt: string;
  updatedAt: string;
  status: string;
  openTx: string;
  closeTx?: string;
  trades?: { txId: string; inputAmount: string; outputAmount: string; confirmedAt: string }[];
}

/** Translate "auto" | "2.5" (percent) → bps or undefined for dynamic slippage. */
export function slippageBps(s: string | undefined): number | undefined {
  if (s === undefined || s === "auto") return undefined;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new WalletError("INVALID_PARAM", 'slippage must be "auto" or a percent between 0 and 100');
  return Math.round(n * 100);
}
