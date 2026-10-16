// x402 payments, buyer side. v2 (PAYMENT-REQUIRED / PAYMENT-SIGNATURE headers, CAIP-2 networks) with v1 fallback.
// Solana "exact" scheme: a transferChecked from the wallet's token account to the merchant, fee paid by the
// facilitator (extra.feePayer), partially signed here and settled by the merchant/facilitator.
import { randomUUID } from "node:crypto";
import { address, appendTransactionMessageInstructions, createTransactionMessage, getBase64EncodedWireTransaction, partiallySignTransactionWithSigners, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash, compileTransaction, type Address } from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { findAssociatedTokenPda, getTransferCheckedInstruction } from "@solana-program/token";
import type { Ctx } from "./ctx.js";
import { Collection } from "./store.js";
import { WalletError } from "./errors.js";
import { cluster, X402_NETWORK, CHAIN_ID } from "./config.js";
import { readPolicy, tokenAllowed } from "./policy.js";
import { fromUnits, known, resolveToken, type TokenRef } from "./tokens.js";
import { prices } from "./prices.js";
import { loadSigner, walletAddress } from "./signer.js";
import { tokenBalanceUnits } from "./send.js";
import { quotaLimit, quotaUsed } from "./orders.js";

export interface Accept {
  scheme: string;
  network: string;
  asset?: string;
  amount?: string;
  maxAmountRequired?: string; // v1
  payTo: string;
  maxTimeoutSeconds?: number;
  resource?: string; // v1
  description?: string;
  mimeType?: string;
  extra?: { feePayer?: string; name?: string; version?: string; [k: string]: unknown };
}

export interface PaymentRequired {
  x402Version: number;
  resource?: { url: string; description?: string; mimeType?: string };
  accepts: Accept[];
  error?: string;
  extensions?: Record<string, unknown>;
}

export type OptionStatus = "READY_TO_SIGN" | "ACTION_REQUIRED" | "NOT_SIGNABLE";

export interface Option {
  index: number;
  status: OptionStatus;
  reasons: string[];
  scheme: string;
  assetTransferMethod: "spl-transfer" | null;
  binanceChainId: string | null;
  tokenAddress: string | null;
  tokenSymbol: string | null;
  amount: string | null;
  amountUsd: string | null;
  payTo: string | null;
  userWalletAddress: string | null;
  currentBalance: string | null;
  currentBalanceUsd: string | null;
  needApproveFirst: false;
  feePayer: string | null;
  originalAccept: Accept;
}

export interface X402Preview {
  id: string;
  createdAt: number;
  expiresAt: number;
  version: number;
  resource: PaymentRequired["resource"] | null;
  options: Option[];
}

export const x402Previews = new Collection<X402Preview>("x402-previews");

export function parsePaymentRequired(input: string | Record<string, unknown>): PaymentRequired {
  let obj: unknown = input;
  if (typeof input === "string") {
    const s = input.trim();
    try {
      obj = JSON.parse(s);
    } catch {
      try {
        obj = JSON.parse(Buffer.from(s, "base64").toString("utf8"));
      } catch {
        throw new WalletError("INVALID_PARAM", "paymentRequirements must be the PaymentRequired JSON or its base64 header value.");
      }
    }
  }
  const pr = obj as PaymentRequired;
  if (!pr || typeof pr !== "object" || !Array.isArray(pr.accepts)) throw new WalletError("INVALID_PARAM", "PaymentRequired has no `accepts` array.");
  return pr;
}

export function networkMatches(net: string): boolean {
  const c = cluster();
  if (net === X402_NETWORK[c]) return true;
  if (c === "mainnet" && (net === "solana" || net === "solana-mainnet")) return true;
  if (c === "devnet" && (net === "solana-devnet")) return true;
  return false;
}

export async function previewX402(ctx: Ctx, input: string | Record<string, unknown>): Promise<{ paymentId: string; options: Option[]; resource: PaymentRequired["resource"] | null; x402Version: number }> {
  const pr = parsePaymentRequired(input);
  const policy = readPolicy();
  const wallet = await walletAddress();
  const limit = quotaLimit(policy, "x402");
  const used = quotaUsed("x402");
  const options: Option[] = [];
  for (const [i, acc] of pr.accepts.entries()) {
    const base: Option = {
      index: i + 1, status: "NOT_SIGNABLE", reasons: [], scheme: acc.scheme, assetTransferMethod: null, binanceChainId: null, tokenAddress: null, tokenSymbol: null,
      amount: null, amountUsd: null, payTo: acc.payTo ?? null, userWalletAddress: null, currentBalance: null, currentBalanceUsd: null, needApproveFirst: false, feePayer: acc.extra?.feePayer ?? null, originalAccept: acc,
    };
    const amountRaw = acc.amount ?? acc.maxAmountRequired;
    if (!acc.scheme || !acc.network || !acc.payTo || !amountRaw || !acc.asset) {
      options.push({ ...base, reasons: ["INVALID_ACCEPT_STRUCTURE"] });
      continue;
    }
    if (acc.scheme !== "exact") {
      options.push({ ...base, reasons: ["UNSUPPORTED_SCHEME"] });
      continue;
    }
    if (!acc.network.startsWith("solana")) {
      options.push({ ...base, reasons: ["UNSUPPORTED_NETWORK"] });
      continue;
    }
    if (!networkMatches(acc.network)) {
      options.push({ ...base, reasons: ["UNSUPPORTED_NETWORK"], binanceChainId: CHAIN_ID });
      continue;
    }
    if (!acc.extra?.feePayer) {
      options.push({ ...base, reasons: ["INVALID_ACCEPT_STRUCTURE"], binanceChainId: CHAIN_ID });
      continue;
    }
    let token: TokenRef;
    try {
      token = await resolveToken(ctx, acc.asset);
    } catch {
      options.push({ ...base, reasons: ["INVALID_ACCEPT_STRUCTURE"], binanceChainId: CHAIN_ID, tokenAddress: acc.asset });
      continue;
    }
    if (token.native) {
      options.push({ ...base, reasons: ["UNSUPPORTED_METHOD"], binanceChainId: CHAIN_ID, tokenAddress: acc.asset, tokenSymbol: token.symbol });
      continue;
    }
    const units = BigInt(amountRaw);
    const amount = fromUnits(units, token.decimals);
    const px = (await prices(ctx, [token.mint]))[token.mint];
    const usd = px === null ? null : Number(amount) * px;
    const bal = await tokenBalanceUnits(ctx, wallet, token).catch(() => 0n);
    const balance = fromUnits(bal, token.decimals);
    const reasons: string[] = [];
    if (!tokenAllowed(policy, token.mint)) reasons.push("BLOCKED_BY_SECURITY_CHECK");
    if (usd === null && !policy.allowUnpricedTokens) reasons.push("BLOCKED_BY_SECURITY_CHECK");
    if (usd !== null && used + usd > limit) reasons.push("BLOCKED_DAILY_LIMIT_REACHED");
    if (bal < units) reasons.push("INSUFFICIENT_BALANCE");
    const status: OptionStatus = reasons.some((r) => r !== "INSUFFICIENT_BALANCE") ? "NOT_SIGNABLE" : reasons.length ? "ACTION_REQUIRED" : "READY_TO_SIGN";
    options.push({
      ...base,
      status,
      reasons,
      assetTransferMethod: "spl-transfer",
      binanceChainId: CHAIN_ID,
      tokenAddress: token.mint,
      tokenSymbol: token.symbol,
      amount,
      amountUsd: usd === null ? null : usd.toFixed(2),
      userWalletAddress: wallet,
      currentBalance: balance,
      currentBalanceUsd: px === null ? null : (Number(balance) * px).toFixed(2),
    });
  }
  const rank = { READY_TO_SIGN: 0, ACTION_REQUIRED: 1, NOT_SIGNABLE: 2 };
  options.sort((a, b) => rank[a.status] - rank[b.status] || (known(a.tokenAddress ?? "") ? -1 : 1));
  options.forEach((o, i) => (o.index = i + 1));
  const id = randomUUID();
  x402Previews.put({ id, createdAt: Date.now(), expiresAt: Date.now() + 10 * 60 * 1000, version: pr.x402Version ?? 2, resource: pr.resource ?? null, options });
  return { paymentId: id, options, resource: pr.resource ?? null, x402Version: pr.x402Version ?? 2 };
}

export function loadX402(paymentId: string): X402Preview {
  const p = x402Previews.get(paymentId);
  if (!p) throw new WalletError("TARGET_NOT_FOUND", `No x402 preview ${paymentId}. Run x402-payment preview first.`);
  if (p.expiresAt < Date.now()) {
    x402Previews.remove(paymentId);
    throw new WalletError("PREVIEW_EXPIRED", "x402 preview expired; run preview again.");
  }
  return p;
}

/** Build and partially sign the exact-scheme transfer. Returns the header name/value to replay the request with. */
export async function signX402(ctx: Ctx, p: X402Preview, opt: Option): Promise<{ paymentHeaderName: string; paymentHeaderValue: string; signatureExpiresAt: number; transaction: string }> {
  const wallet = await loadSigner();
  const acc = opt.originalAccept;
  const token = await resolveToken(ctx, acc.asset!);
  const units = BigInt(acc.amount ?? acc.maxAmountRequired!);
  const mint = address(token.mint);
  const payTo = address(acc.payTo);
  const feePayer = address(acc.extra!.feePayer!);
  const [src] = await findAssociatedTokenPda({ mint, owner: wallet.address, tokenProgram: token.programAddress });
  const [dst] = await findAssociatedTokenPda({ mint, owner: payTo, tokenProgram: token.programAddress });
  const { value: bh } = await ctx.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const msg = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) =>
      appendTransactionMessageInstructions(
        [
          getSetComputeUnitLimitInstruction({ units: 20_000 }),
          getSetComputeUnitPriceInstruction({ microLamports: 1 }),
          getTransferCheckedInstruction({ source: src, mint, destination: dst, authority: wallet, amount: units, decimals: token.decimals }, { programAddress: token.programAddress }),
        ],
        m,
      ),
  );
  const signed = await partiallySignTransactionWithSigners([wallet], compileTransaction(msg));
  const transaction = getBase64EncodedWireTransaction(signed);
  const v2 = p.version >= 2;
  const payload = v2
    ? { x402Version: 2, resource: p.resource ?? undefined, accepted: acc, payload: { transaction } }
    : { x402Version: 1, scheme: acc.scheme, network: acc.network, payload: { transaction } };
  const ttl = Math.min(acc.maxTimeoutSeconds ?? 60, 60); // a blockhash lasts ~60–90 s
  return {
    paymentHeaderName: v2 ? "PAYMENT-SIGNATURE" : "X-PAYMENT",
    paymentHeaderValue: Buffer.from(JSON.stringify(payload)).toString("base64"),
    signatureExpiresAt: Math.floor(Date.now() / 1000) + ttl,
    transaction,
  };
}

/** Decode a PAYMENT-RESPONSE / X-PAYMENT-RESPONSE header. */
export function decodeSettlement(header: string | null): Record<string, unknown> | null {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function addr(a: string): Address {
  return address(a);
}
