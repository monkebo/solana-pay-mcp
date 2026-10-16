// The control plane's pluggable execution layer. Policy, sessions, approvals and the ledger live above this line;
// below it, one of several wallets actually holds the funds:
//   local      a keypair file on the vault host (self-custody)
//   baw        Binance Agentic Wallet, driven through its `baw` CLI
//   signer     any HTTP remote signer (Turnkey, Privy, Fireblocks, your own HSM) speaking a 2-endpoint protocol
//   solana-pay a human's wallet (Phantom, Solflare, Backpack): the agent prepares, the human scans and signs
// Switching backends is an owner action; agents and their prompts do not change.
import type { Address, TransactionPartialSigner } from "@solana/kit";
import type { Ctx } from "./ctx.js";
import { readPolicy } from "./policy.js";
import { WalletError } from "./errors.js";
import type { BalanceRow } from "./view.js";
import type { PreparedSend, SendParams } from "./send.js";
import type { PreparedSwap, SwapArgs } from "./swap.js";
import type { Option, X402Preview } from "./x402.js";
import type { OrderStatus } from "./orders.js";

export type BackendKind = "local" | "baw" | "signer" | "solana-pay";

/** What the transaction pipeline needs from a backend that can sign. `keyPair` is present only for the local key. */
export type WalletSigner = TransactionPartialSigner & { address: Address; keyPair?: CryptoKeyPair };

export interface SendOutcome {
  txHash: string | null;
  status: OrderStatus;
  /** Extra fields for the caller's result (e.g. a Solana Pay link for the human wallet). */
  extra?: Record<string, unknown>;
  signedTx?: string;
  lastValidBlockHeight?: number;
}

export interface Backend {
  kind: BackendKind;
  label: string;
  /** Can produce signatures for arbitrary transactions built by this wallet. */
  canSign: boolean;
  address(): Promise<Address>;
  signer(): Promise<WalletSigner>;
  status(ctx: Ctx): Promise<{ connected: boolean; detail: string }>;
  balances?(ctx: Ctx): Promise<BalanceRow[]>;
  send?(ctx: Ctx, prepared: PreparedSend, params: SendParams): Promise<SendOutcome>;
  swap?(ctx: Ctx, prepared: PreparedSwap, args: SwapArgs): Promise<{ txHash: string | null; upstreamOrderId: string | null; status: OrderStatus }>;
  x402Sign?(ctx: Ctx, preview: X402Preview, option: Option): Promise<{ paymentHeaderName: string; paymentHeaderValue: string; signatureExpiresAt: number }>;
  /** Run a command this control plane has no native implementation for (DeFi, prediction markets...). */
  forward?(ctx: Ctx, cliWords: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface BackendConfig {
  kind: BackendKind;
  baw?: { bin?: string };
  signer?: { url: string; token?: string; address?: string };
  solanaPay?: { address: string; label?: string };
}

type Factory = (cfg: BackendConfig) => Backend;
const factories = new Map<BackendKind, Factory>();

export function registerBackend(kind: BackendKind, f: Factory): void {
  factories.set(kind, f);
}

let cache: { key: string; backend: Backend } | undefined;

export function activeBackend(): Backend {
  const cfg = readPolicy().backend;
  const key = JSON.stringify(cfg);
  if (cache?.key === key) return cache.backend;
  const f = factories.get(cfg.kind);
  if (!f) throw new WalletError("NOT_SUPPORTED", `Backend "${cfg.kind}" is not available in this build.`);
  cache = { key, backend: f(cfg) };
  return cache.backend;
}

export function resetBackendCache(): void {
  cache = undefined;
}

export function backendKinds(): BackendKind[] {
  return [...factories.keys()];
}

export function notSigning(kind: BackendKind, what: string): WalletError {
  return new WalletError(
    "NOT_SUPPORTED",
    `${what} needs a backend that can sign arbitrary transactions; the active backend is "${kind}". The owner can switch with \`saw owner set-backend --kind local\` (or signer).`,
  );
}
