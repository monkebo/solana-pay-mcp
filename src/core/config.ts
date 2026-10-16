// Environment and paths. Everything the wallet reads from the outside world starts here.
import { homedir } from "node:os";
import { join } from "node:path";

export type Cluster = "mainnet" | "devnet";

export const CLI_VERSION = "0.5.0";
export const SKILL_NAME = "solana-agentic-wallet";

/** Binance-style chain id for Solana, kept so skills written against `baw` map 1:1. */
export const CHAIN_ID = "CT_501";
export const CHAINS = [{ binanceChainId: CHAIN_ID, name: "Solana", simpleName: "Solana" }];

export function home(): string {
  return process.env.SAW_HOME ?? process.env.SOLANA_PAY_MCP_HOME ?? join(homedir(), ".solana-pay-mcp");
}

export function cluster(): Cluster {
  const c = process.env.SOLANA_CLUSTER ?? "devnet";
  if (c !== "devnet" && c !== "mainnet") throw new Error(`SOLANA_CLUSTER must be devnet|mainnet, got ${c}`);
  return c;
}

export function rpcUrl(): string {
  return process.env.SOLANA_RPC_URL ?? (cluster() === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com");
}

export function keyPath(): string {
  return process.env.SOLANA_PAY_SIGNER ?? join(home(), "agent.json");
}

/** Jupiter APIs: swap/quote, trigger (limit) orders, prices, token search, lend. Override for a paid tier or a mock. */
export function jupiterBase(): string {
  return (process.env.JUPITER_API_BASE ?? "https://lite-api.jup.ag").replace(/\/$/, "");
}
export function jupiterKey(): string | undefined {
  return process.env.JUPITER_API_KEY;
}

/** Genesis-hash CAIP-2 ids used by x402 v2 for Solana. */
export const X402_NETWORK: Record<Cluster, string> = {
  mainnet: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
};

export function explorerUrl(sig: string): string {
  return `https://explorer.solana.com/tx/${sig}${cluster() === "devnet" ? "?cluster=devnet" : ""}`;
}

export function nowMs(): number {
  return Date.now();
}

/** "48h" | "30m" | "7d" → ms */
export function parseDuration(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s.trim());
  if (!m) throw new Error(`bad duration: ${s}`);
  const n = Number(m[1]);
  return n * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as "s" | "m" | "h" | "d"];
}
