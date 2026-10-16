// Build → simulate → sign → broadcast. One path for every transaction the wallet makes.
// Broadcast returns immediately; confirmation is tracked by orders + track.ts.
import {
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  prependTransactionMessageInstructions,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type Base64EncodedWireTransaction,
  type Signature,
} from "@solana/kit";
import { getSetComputeUnitLimitInstruction, getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import type { Ctx } from "./ctx.js";
import { loadSigner } from "./signer.js";
import { WalletError } from "./errors.js";
import { DEFAULT_CU, gasLevels, type GasLevel } from "./view.js";

export interface Broadcast {
  signature: string;
  /** Base64 wire transaction, kept so `wallet speed-up` can rebroadcast it. */
  signedTx: string;
  lastValidBlockHeight: number;
  computeUnits: number;
  priorityFeeMicroLamports: number;
  simulationLogs: string[];
}

export interface Simulation {
  unitsConsumed: number;
  logs: string[];
  err: unknown;
}

export async function cuPrice(ctx: Ctx, level: GasLevel): Promise<number> {
  const g = await gasLevels(ctx).catch(() => null);
  return Number(g?.[level.toLowerCase() as "low" | "medium" | "high"].gasPrice ?? { LOW: 1000, MEDIUM: 10_000, HIGH: 100_000 }[level]);
}

/** Simulate a base64 wire transaction (signatures not verified, blockhash replaced). */
export async function simulateWire(ctx: Ctx, wire: string, withAccounts: string[] = []): Promise<Simulation & { accounts?: unknown[] }> {
  const res = await ctx.rpc
    .simulateTransaction(wire as Base64EncodedWireTransaction, {
      encoding: "base64",
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: "confirmed",
      ...(withAccounts.length ? { accounts: { encoding: "jsonParsed", addresses: withAccounts as never } } : {}),
    } as never)
    .send();
  const v = res.value as { err: unknown; logs: string[] | null; unitsConsumed?: bigint; accounts?: unknown[] };
  return { unitsConsumed: Number(v.unitsConsumed ?? 0), logs: v.logs ?? [], err: v.err, accounts: v.accounts };
}

/** Build and sign a v0 transaction around `instructions`, sizing compute from a simulation. */
export async function buildSigned(ctx: Ctx, instructions: Instruction[], opts: { gasLevel?: GasLevel; computeUnits?: number } = {}) {
  const signer = await loadSigner();
  const price = await cuPrice(ctx, opts.gasLevel ?? "MEDIUM");
  const { value: bh } = await ctx.rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const base = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const withBudget = (units: number) =>
    prependTransactionMessageInstructions([getSetComputeUnitLimitInstruction({ units }), getSetComputeUnitPriceInstruction({ microLamports: price })], base);
  // Draft at the maximum so simulation can tell us what the transaction really needs.
  const draft = await signTransactionMessageWithSigners(withBudget(1_400_000));
  const sim = await simulateWire(ctx, getBase64EncodedWireTransaction(draft));
  if (sim.err) {
    throw new WalletError("SIMULATION_FAILED", `Transaction simulation failed: ${explainSimError(sim.err, sim.logs)}`, { err: sim.err, logs: sim.logs.slice(-15) });
  }
  const units = opts.computeUnits ?? Math.min(1_400_000, Math.max(5000, Math.ceil(sim.unitsConsumed * 1.15) + 1000));
  const signed = await signTransactionMessageWithSigners(withBudget(units));
  return { signed, wire: getBase64EncodedWireTransaction(signed), lastValidBlockHeight: Number(bh.lastValidBlockHeight), units, price, logs: sim.logs };
}

export async function broadcastWire(ctx: Ctx, wire: string): Promise<string> {
  try {
    const sig = await ctx.rpc.sendTransaction(wire as Base64EncodedWireTransaction, { encoding: "base64", skipPreflight: true, maxRetries: 3n, preflightCommitment: "confirmed" }).send();
    return sig as string;
  } catch (e) {
    throw new WalletError("BROADCAST_FAILED", `Broadcast failed: ${(e as Error).message}`);
  }
}

/** The whole pipeline for wallet-built transactions. */
export async function sendInstructions(ctx: Ctx, instructions: Instruction[], opts: { gasLevel?: GasLevel } = {}): Promise<Broadcast> {
  const b = await buildSigned(ctx, instructions, opts);
  const signature = await broadcastWire(ctx, b.wire);
  return { signature, signedTx: b.wire, lastValidBlockHeight: b.lastValidBlockHeight, computeUnits: b.units, priorityFeeMicroLamports: b.price, simulationLogs: b.logs };
}

export function signatureOf(signed: Parameters<typeof getSignatureFromTransaction>[0]): Signature {
  return getSignatureFromTransaction(signed);
}

export function explainSimError(err: unknown, logs: string[]): string {
  const s = JSON.stringify(err);
  const last = logs.filter((l) => /Error|failed|insufficient/i.test(l)).slice(-2).join(" | ");
  if (/InsufficientFundsForRent|insufficient lamports/i.test(s + last)) return `insufficient SOL for fees/rent (${last || s})`;
  if (/"Custom":1\b|insufficient funds/i.test(s + last)) return `insufficient token balance (${last || s})`;
  if (/AccountNotFound/.test(s)) return "fee payer account not found: the wallet has no SOL";
  return last ? `${s} (${last})` : s;
}

// ---- Externally built transactions (Jupiter, x402 facilitators, user-supplied) ----
import { getBase64Encoder, getTransactionDecoder, partiallySignTransactionWithSigners, getCompiledTransactionMessageDecoder } from "@solana/kit";

/** Decode a base64 wire transaction into kit's Transaction shape. */
export function decodeWire(base64: string) {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(getBase64Encoder().encode(base64));
    return getTransactionDecoder().decode(bytes);
  } catch (e) {
    throw new WalletError("INVALID_PARAM", `Not a valid base64 Solana transaction: ${(e as Error).message}`);
  }
}

/** Compiled message view: static account keys, instructions, lifetime token. */
export function decodeMessage(tx: ReturnType<typeof decodeWire>) {
  return getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
}

/** Sign an externally built transaction with the wallet key (partial: other signers may already be present). */
export async function signWire(base64: string): Promise<{ wire: string; signature: string; signed: Awaited<ReturnType<typeof partiallySignTransactionWithSigners>> }> {
  const signer = await loadSigner();
  const tx = decodeWire(base64);
  const signed = await partiallySignTransactionWithSigners([signer], tx);
  return { wire: getBase64EncodedWireTransaction(signed), signature: getSignatureFromTransaction(signed), signed };
}

/** Simulate, then sign and broadcast an externally built transaction. */
export async function sendWire(ctx: Ctx, base64: string, opts: { simulate?: boolean; lastValidBlockHeight?: number } = {}): Promise<Broadcast> {
  if (opts.simulate !== false) {
    const sim = await simulateWire(ctx, base64);
    if (sim.err) throw new WalletError("SIMULATION_FAILED", `Transaction simulation failed: ${explainSimError(sim.err, sim.logs)}`, { err: sim.err, logs: sim.logs.slice(-15) });
  }
  const { wire, signature } = await signWire(base64);
  await broadcastWire(ctx, wire);
  let lvbh = opts.lastValidBlockHeight;
  if (lvbh === undefined) {
    try {
      lvbh = Number((await ctx.rpc.getBlockHeight().send()) + 150n);
    } catch {
      lvbh = 0;
    }
  }
  return { signature, signedTx: wire, lastValidBlockHeight: lvbh, computeUnits: 0, priorityFeeMicroLamports: 0, simulationLogs: [] };
}
