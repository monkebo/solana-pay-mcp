// Token identity: symbol ↔ mint ↔ decimals ↔ program. Known stables are hard-coded; everything else is looked up
// on-chain (decimals, program) and via Jupiter token search (symbol, audit flags). Never guess an address.
import { address, type Address } from "@solana/kit";
import { fetchMint, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { Ctx } from "./ctx.js";
import { cluster, jupiterBase, jupiterKey } from "./config.js";
import { SOL_MINT, USDC_MINT, USDT_MINT } from "./policy.js";
import { WalletError } from "./errors.js";

export const TOKEN_2022_PROGRAM_ADDRESS = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export { SOL_MINT, USDC_MINT, USDT_MINT };

export interface TokenRef {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  /** Native SOL (not wrapped): transfers use the System program. */
  native: boolean;
  programAddress: Address;
}

const KNOWN: Record<string, Omit<TokenRef, "mint" | "programAddress"> & { clusters?: ("mainnet" | "devnet")[] }> = {
  [SOL_MINT]: { symbol: "SOL", name: "Solana", decimals: 9, native: true },
  [USDC_MINT.mainnet]: { symbol: "USDC", name: "USD Coin", decimals: 6, native: false, clusters: ["mainnet"] },
  [USDC_MINT.devnet]: { symbol: "USDC", name: "USD Coin (devnet)", decimals: 6, native: false, clusters: ["devnet"] },
  [USDT_MINT]: { symbol: "USDT", name: "Tether USD", decimals: 6, native: false, clusters: ["mainnet"] },
};

export const STABLE_MINTS = new Set([USDC_MINT.mainnet, USDC_MINT.devnet, USDT_MINT]);

export function knownBySymbol(symbol: string): string | undefined {
  const s = symbol.toUpperCase();
  if (s === "SOL") return SOL_MINT;
  if (s === "USDC") return USDC_MINT[cluster()];
  if (s === "USDT" && cluster() === "mainnet") return USDT_MINT;
  return undefined;
}

export function known(mint: string): TokenRef | undefined {
  const k = KNOWN[mint];
  if (!k) return undefined;
  return { mint, symbol: k.symbol, name: k.name, decimals: k.decimals, native: k.native, programAddress: TOKEN_PROGRAM_ADDRESS };
}

const cache = new Map<string, TokenRef>();

/** Accepts "SOL", "USDC", "USDT" or a mint address. Unknown mints are resolved on-chain. */
export async function resolveToken(ctx: Ctx, idOrSymbol: string): Promise<TokenRef> {
  const bySymbol = knownBySymbol(idOrSymbol);
  const mint = bySymbol ?? idOrSymbol.trim();
  const k = known(mint);
  if (k) return k;
  if (cache.has(mint)) return cache.get(mint)!;
  let a: Address;
  try {
    a = address(mint);
  } catch {
    throw new WalletError("INVALID_PARAM", `"${idOrSymbol}" is not a token symbol I know (SOL, USDC, USDT) nor a valid mint address. Use the full mint address.`);
  }
  let decimals: number;
  let programAddress: Address;
  try {
    const m = await fetchMint(ctx.rpc, a);
    decimals = m.data.decimals;
    programAddress = m.programAddress;
  } catch (e) {
    throw new WalletError("TARGET_NOT_FOUND", `${mint} is not a token mint on ${cluster()}: ${(e as Error).message}`);
  }
  const meta = await jupiterTokenInfo(ctx, mint).catch(() => null);
  const ref: TokenRef = { mint, symbol: meta?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`, name: meta?.name ?? "Unknown token", decimals, native: false, programAddress };
  cache.set(mint, ref);
  return ref;
}

export interface JupToken {
  id: string;
  name: string;
  symbol: string;
  decimals: number;
  icon?: string;
  tags?: string[];
  usdPrice?: number;
  liquidity?: number;
  mcap?: number;
  holderCount?: number;
  organicScore?: number;
  organicScoreLabel?: string;
  isVerified?: boolean;
  audit?: { mintAuthorityDisabled?: boolean; freezeAuthorityDisabled?: boolean; topHoldersPercentage?: number; devBalancePercentage?: number };
}

export function jupHeaders(): Record<string, string> {
  const k = jupiterKey();
  return { accept: "application/json", ...(k ? { "x-api-key": k } : {}) };
}

/** Jupiter token search by mint or symbol. Mainnet data; on devnet only hard-coded tokens resolve. */
export async function jupiterTokenInfo(ctx: Ctx, query: string): Promise<JupToken | null> {
  const r = await ctx.fetch(`${jupiterBase()}/tokens/v2/search?query=${encodeURIComponent(query)}`, { headers: jupHeaders(), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new WalletError("UPSTREAM_ERROR", `Jupiter token search ${r.status}`);
  const list = (await r.json()) as JupToken[];
  return list.find((t) => t.id === query) ?? list[0] ?? null;
}

/** Decimal string → base units, strict on precision. */
export function toUnits(amount: string, decimals: number): bigint {
  const m = new RegExp(`^(\\d+)(?:\\.(\\d{1,${Math.max(decimals, 1)}}))?$`).exec(amount.trim());
  if (!m) throw new WalletError("INVALID_PARAM", `Amount "${amount}" must be a decimal with at most ${decimals} decimals.`);
  const frac = (m[2] ?? "").padEnd(decimals, "0").slice(0, decimals);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt(frac || "0");
}

export function fromUnits(units: bigint | number | string, decimals: number): string {
  const s = BigInt(units).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals) || "0";
  const frac = decimals ? s.slice(-decimals).replace(/0+$/, "") : "";
  return frac ? `${whole}.${frac}` : whole;
}
