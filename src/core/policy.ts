// Security policy. Read by the agent (`wallet settings`), written only by the owner (`owner set-policy`, vault UI).
// Mirrors the Binance Agentic Wallet settings page field for field, plus a few self-custody extras.
import { Doc } from "./store.js";
import { parseDuration } from "./config.js";
import { WalletError } from "./errors.js";
import type { BackendConfig } from "./backend.js";
import { currentAgent } from "./agents.js";

export type AbnormalHandling = "AutoReject" | "NeedConfirmation";

export interface Policy {
  version: 1;
  /** Max total USD value of sends/swaps/limit orders per rolling 24h. */
  dailyLimitUsd: number;
  /** Max USD value of a single transaction (null = no per-tx cap). */
  maxPaymentUsd: number | null;
  /** What to do with a transaction flagged as risky or over `confirmAboveUsd`. */
  abnormalTxnHandling: AbnormalHandling;
  /** Any transaction above this USD value needs owner confirmation (null = never on amount alone). */
  confirmAboveUsd: number | null;
  /** When false only `allowedTokens` may be sent or traded. */
  tradeAllTokens: boolean;
  /** Mints the agent may touch when `tradeAllTokens` is false. SOL is the wrapped-SOL mint. */
  allowedTokens: string[];
  /** Sends only to saved address-book entries. */
  addressBookOnly: boolean;
  /** If a token has no USD price, allow it anyway (counts as 0 toward limits). Default false: fail closed. */
  allowUnpricedTokens: boolean;
  maxSigninDuration: string;
  inactiveSignoutDuration: string;
  /** Vault mode: the owner must approve each `auth signin` pairing. Local mode: auto-approved. */
  requirePairingApproval: boolean;
  x402DailyLimitUsd: number;
  /** Owner-wide stop: every fleet agent is refused until resumed. The treasury wallet is unaffected. */
  fleetPaused: boolean;
  /** Which wallet executes: local key, Binance baw, HTTP signer, or a human's wallet via Solana Pay. */
  backend: BackendConfig;
}

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = { mainnet: "EPjFWdd5AufqSSqeM2qN1xqybapC8G4wEGGkZwyTDt1v", devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" } as const;
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

export function defaultPolicy(): Policy {
  return {
    version: 1,
    dailyLimitUsd: 100,
    maxPaymentUsd: 50,
    abnormalTxnHandling: "NeedConfirmation",
    confirmAboveUsd: null,
    tradeAllTokens: false,
    allowedTokens: [SOL_MINT, USDC_MINT.mainnet, USDC_MINT.devnet, USDT_MINT],
    addressBookOnly: true,
    allowUnpricedTokens: false,
    maxSigninDuration: "48h",
    inactiveSignoutDuration: "48h",
    requirePairingApproval: false,
    x402DailyLimitUsd: 20,
    fleetPaused: false,
    backend: { kind: "local" },
  };
}

const doc = new Doc<Policy>("policy", defaultPolicy);

/** Effective policy for the current call: the owner's policy, with the current fleet agent's overrides on top. */
export function readPolicy(): Policy {
  const base = doc.read();
  const a = currentAgent();
  return a ? { ...base, ...a.policy } : base;
}

/** The stored owner policy, without agent overrides. Owner commands edit this one. */
export function readOwnerPolicy(): Policy {
  return doc.read();
}

export function writePolicy(p: Policy): Policy {
  parseDuration(p.maxSigninDuration);
  parseDuration(p.inactiveSignoutDuration);
  for (const k of ["dailyLimitUsd", "x402DailyLimitUsd"] as const) {
    if (!(Number.isFinite(p[k]) && p[k] >= 0)) throw new WalletError("INVALID_PARAM", `${k} must be a non-negative number`);
  }
  if (!["local", "baw", "signer", "solana-pay"].includes(p.backend?.kind)) throw new WalletError("INVALID_PARAM", "backend.kind must be local | baw | signer | solana-pay");
  return doc.write({ ...p, version: 1 });
}

/** Owner-side patch with dot paths such as `devMode.enabled=true`. Values are JSON when parseable, else strings. */
export function patchPolicy(pairs: Record<string, unknown>): Policy {
  const p = structuredClone(readOwnerPolicy()) as Policy;
  for (const [path, raw] of Object.entries(pairs)) {
    let v: unknown = raw;
    if (typeof raw === "string") {
      try {
        v = JSON.parse(raw);
      } catch {
        v = raw;
      }
    }
    const keys = path.split(".");
    let cur: Record<string, unknown> = p as unknown as Record<string, unknown>;
    for (const k of keys.slice(0, -1)) {
      if (typeof cur[k] !== "object" || cur[k] === null) throw new WalletError("INVALID_PARAM", `unknown policy field ${path}`);
      cur = cur[k] as Record<string, unknown>;
    }
    const last = keys[keys.length - 1];
    if (!(last in cur)) throw new WalletError("INVALID_PARAM", `unknown policy field ${path}`);
    cur[last] = v;
  }
  return writePolicy(p);
}

export function tokenAllowed(p: Policy, mint: string): boolean {
  return p.tradeAllTokens || p.allowedTokens.includes(mint);
}
