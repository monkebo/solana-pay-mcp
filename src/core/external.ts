// Developer mode: sign things the wallet did not build itself.
//   contract-call preview/execute  → an unsigned base64 transaction from a dApp/SDK
//   sign-message preview/execute   → Solana off-chain message (standard envelope) or raw bytes
// Two-step by design: preview parses, simulates and scores risk; execute only takes a fresh requestId.
import { randomUUID } from "node:crypto";
import { address, getBase58Decoder, getBase64Encoder, signBytes, type Address } from "@solana/kit";
import {
  compileOffchainMessageEnvelope,
  getOffchainMessageEnvelopeEncoder,
  offchainMessageApplicationDomain,
  offchainMessageContentRestrictedAsciiOf1232BytesMax,
  offchainMessageContentUtf8Of1232BytesMax,
  offchainMessageContentUtf8Of65535BytesMax,
  signOffchainMessageEnvelope,
  type OffchainMessageV0,
} from "@solana/offchain-messages";
import type { Ctx } from "./ctx.js";
import { Collection } from "./store.js";
import { WalletError } from "./errors.js";
import { readPolicy } from "./policy.js";
import { decodeMessage, decodeWire, simulateWire } from "./tx.js";
import { loadSigner } from "./signer.js";
import { tokenAccounts } from "./view.js";
import { prices } from "./prices.js";
import { fromUnits, known, SOL_MINT, TOKEN_2022_PROGRAM_ADDRESS } from "./tokens.js";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { CHAIN_ID } from "./config.js";
import type { RiskItem } from "./risk.js";

export interface Preview {
  id: string;
  kind: "contract-call" | "sign-message";
  createdAt: number;
  expiresAt: number;
  usd: number;
  reasons: string[];
  payload: Record<string, unknown>;
  result: Record<string, unknown>;
}

export const previews = new Collection<Preview>("previews");
export const PREVIEW_TTL = 10 * 60 * 1000;

export interface SignatureRecord {
  id: string; // orderId
  signatureType: "offchain_message" | "raw_bytes";
  binanceChainId: string;
  address: string;
  signatureHash: string; // base58 signature
  signatureHex: string;
  signatureTime: number;
  messageType: string;
  applicationDomain: string | null;
  rawData: string;
}
export const signatures = new Collection<SignatureRecord>("signatures");

export function assertDevMode(): void {
  const p = readPolicy();
  if (!p.devMode.enabled) {
    throw new WalletError("DEV_MODE_DISABLED", "Developer Mode is off. External signing (contract-call, sign-message) needs the owner to run `saw owner dev-mode --enabled true --hours 24 --dailyLimitUsd <usd>`.");
  }
}

export function loadPreview(id: string, kind: Preview["kind"]): Preview {
  const p = previews.get(id);
  if (!p || p.kind !== kind) throw new WalletError("TARGET_NOT_FOUND", `No ${kind} preview with requestId ${id}. Run preview first.`);
  if (p.expiresAt < Date.now()) {
    previews.remove(id);
    throw new WalletError("PREVIEW_EXPIRED", "That preview expired. Run preview again and execute within 10 minutes.");
  }
  return p;
}

const PROGRAMS: Record<string, string> = {
  "11111111111111111111111111111111": "System",
  [TOKEN_PROGRAM_ADDRESS]: "Token",
  [TOKEN_2022_PROGRAM_ADDRESS]: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "AssociatedTokenAccount",
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: "Memo",
  Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH: "Memo",
  ComputeBudget111111111111111111111111111111: "ComputeBudget",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "Jupiter v6",
  jupoNjAxXgZ4rjzxzPMP4oxduvQsQtZzyknqvzYNrNu: "Jupiter Trigger",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "Orca Whirlpool",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
  MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD: "Marinade",
  AddressLookupTab1e1111111111111111111111111: "AddressLookupTable",
  Vote111111111111111111111111111111111111111: "Vote",
  Stake11111111111111111111111111111111111111: "Stake",
};

// Token program instruction discriminators that change who controls funds.
const TOKEN_AUTHORITY_IX: Record<number, string> = { 4: "Approve", 6: "SetAuthority", 13: "ApproveChecked", 9: "CloseAccount" };
const SYSTEM_AUTHORITY_IX: Record<number, string> = { 1: "Assign", 7: "AssignWithSeed", 4: "AdvanceNonceAccount", 6: "AuthorizeNonceAccount" };

export interface ParsedInstruction {
  index: number;
  programAddress: string;
  programName: string;
  accounts: string[];
  dataLength: number;
  note: string | null;
}

export function parseUnsignedTx(base64: string, wallet: string) {
  const tx = decodeWire(base64);
  const msg = decodeMessage(tx) as unknown as {
    version: number | "legacy";
    header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number };
    staticAccounts: string[];
    instructions: { programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }[];
    lifetimeToken: string;
    addressTableLookups?: { lookupTableAddress: string; writableIndexes: number[]; readonlyIndexes: number[] }[];
  };
  const signers = msg.staticAccounts.slice(0, msg.header.numSignerAccounts);
  const feePayer = msg.staticAccounts[0];
  const authorityChanges: { instruction: number; program: string; action: string; accounts: string[] }[] = [];
  const instructions: ParsedInstruction[] = msg.instructions.map((ix, i) => {
    const programAddress = msg.staticAccounts[ix.programAddressIndex] ?? `lookup#${ix.programAddressIndex}`;
    const programName = PROGRAMS[programAddress] ?? "Unknown program";
    const accounts = (ix.accountIndices ?? []).map((a) => msg.staticAccounts[a] ?? `lookup#${a}`);
    const d0 = ix.data?.[0];
    let note: string | null = null;
    if ((programName === "Token" || programName === "Token-2022") && d0 !== undefined && TOKEN_AUTHORITY_IX[d0]) {
      note = TOKEN_AUTHORITY_IX[d0];
      authorityChanges.push({ instruction: i, program: programName, action: note, accounts });
    }
    if (programName === "System" && ix.data && ix.data.length >= 4) {
      const code = ix.data[0] | (ix.data[1] << 8) | (ix.data[2] << 16) | (ix.data[3] << 24);
      if (SYSTEM_AUTHORITY_IX[code]) {
        note = SYSTEM_AUTHORITY_IX[code];
        if (code !== 4) authorityChanges.push({ instruction: i, program: "System", action: note, accounts });
      }
    }
    return { index: i, programAddress, programName, accounts, dataLength: ix.data?.length ?? 0, note };
  });
  const alreadySigned = Object.entries(tx.signatures).filter(([, s]) => s !== null).map(([a]) => a);
  return {
    version: msg.version,
    feePayer,
    signers,
    walletIsSigner: signers.includes(wallet),
    walletIsFeePayer: feePayer === wallet,
    alreadySigned,
    lifetimeToken: msg.lifetimeToken,
    usesAddressLookupTables: Boolean(msg.addressTableLookups?.length),
    hasDurableNonce: instructions.some((i) => i.note === "AdvanceNonceAccount"),
    instructions,
    authorityChanges,
    unknownPrograms: [...new Set(instructions.filter((i) => i.programName === "Unknown program").map((i) => i.programAddress))],
  };
}

export interface BalanceChange {
  tokenSymbol: string;
  tokenAddress: string;
  amount: string; // signed decimal
  valueUsd: string | null;
}

/** Simulate and diff the wallet's SOL and token balances. */
export async function simulateWithBalances(ctx: Ctx, base64: string, wallet: Address): Promise<{ sim: Awaited<ReturnType<typeof simulateWire>>; changes: BalanceChange[]; outflowUsd: number; unpricedOutflow: boolean }> {
  const tas = (await tokenAccounts(ctx, wallet)).flatMap((g) => g.rows).slice(0, 15);
  const addrs = [wallet as string, ...tas.map((t) => t.pubkey)];
  const sim = await simulateWire(ctx, base64, addrs);
  const changes: BalanceChange[] = [];
  let outflowUsd = 0;
  let unpricedOutflow = false;
  if (!sim.err && sim.accounts) {
    const accs = sim.accounts as ({ lamports: bigint | number; data?: { parsed?: { info?: { mint: string; tokenAmount: { amount: string; decimals: number } } } } | unknown[] } | null)[];
    const preSol = BigInt((await ctx.rpc.getBalance(wallet).send()).value);
    const postSol = accs[0] ? BigInt(accs[0].lamports) : 0n;
    const solDelta = postSol - preSol;
    const deltas = new Map<string, { delta: bigint; decimals: number }>();
    if (solDelta !== 0n) deltas.set(SOL_MINT, { delta: solDelta, decimals: 9 });
    tas.forEach((t, i) => {
      const post = accs[i + 1];
      const info = t.account.data.parsed.info;
      const pre = BigInt(info.tokenAmount.amount);
      let postAmt = 0n;
      const parsed = (post?.data as { parsed?: { info?: { tokenAmount: { amount: string } } } } | undefined)?.parsed;
      if (parsed?.info?.tokenAmount) postAmt = BigInt(parsed.info.tokenAmount.amount);
      else if (post === null) postAmt = 0n; // closed
      else return; // not parsed: unknown, skip
      const d = postAmt - pre;
      if (d === 0n) return;
      const cur = deltas.get(info.mint) ?? { delta: 0n, decimals: info.tokenAmount.decimals };
      cur.delta += d;
      deltas.set(info.mint, cur);
    });
    const px = await prices(ctx, [...deltas.keys()]);
    for (const [mint, { delta, decimals }] of deltas) {
      const amt = fromUnits(delta < 0n ? -delta : delta, decimals);
      const p = px[mint];
      const usd = p === null ? null : Number(amt) * p;
      if (delta < 0n) {
        if (usd === null) unpricedOutflow = true;
        else outflowUsd += usd;
      }
      changes.push({ tokenSymbol: known(mint)?.symbol ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`, tokenAddress: mint, amount: `${delta < 0n ? "-" : ""}${amt}`, valueUsd: usd === null ? null : usd.toFixed(2) });
    }
  }
  return { sim, changes, outflowUsd, unpricedOutflow };
}

export async function previewContractCall(ctx: Ctx, unsignedTx: string, from?: string) {
  assertDevMode();
  const wallet = await loadSigner();
  if (from && from !== wallet.address) throw new WalletError("INVALID_PARAM", `--from ${from} is not this wallet (${wallet.address}).`);
  const parsed = parseUnsignedTx(unsignedTx, wallet.address);
  if (!parsed.walletIsSigner) throw new WalletError("INVALID_PARAM", `This transaction does not require ${wallet.address} to sign. Signers: ${parsed.signers.join(", ")}.`);
  const { sim, changes, outflowUsd, unpricedOutflow } = await simulateWithBalances(ctx, unsignedTx, wallet.address);
  const policy = readPolicy();
  const risks: RiskItem[] = [];
  for (const p of parsed.unknownPrograms) risks.push({ code: "UNKNOWN_PROGRAM", title: "Unknown program", description: `Calls ${p}, a program this wallet does not recognise. Verify it with the dApp before signing.`, riskType: "CAUTION" });
  for (const a of parsed.authorityChanges) risks.push({ code: "AUTHORITY_CHANGE", title: `${a.action} (${a.program})`, description: `Instruction #${a.instruction} changes who controls an account: ${a.accounts.slice(0, 3).join(", ")}. This can hand funds to someone else.`, riskType: "RISK" });
  if (parsed.hasDurableNonce) risks.push({ code: "DURABLE_NONCE", title: "Durable nonce", description: "Uses a durable nonce: the signed transaction stays valid indefinitely and can be submitted later.", riskType: "CAUTION" });
  if (parsed.usesAddressLookupTables) risks.push({ code: "ADDRESS_LOOKUP", title: "Address lookup tables", description: "Some accounts are loaded from lookup tables and are not listed here.", riskType: "CAUTION" });
  if (sim.err) risks.push({ code: "SIMULATION_FAILED", title: "Simulation failed", description: JSON.stringify(sim.err), riskType: "RISK" });
  if (unpricedOutflow) risks.push({ code: "UNPRICED_OUTFLOW", title: "Unpriced token leaves the wallet", description: "A token with no USD price is debited; the daily limit cannot value it.", riskType: "CAUTION" });
  if (policy.confirmAboveUsd !== null && outflowUsd > policy.confirmAboveUsd) risks.push({ code: "LARGE_OUTFLOW", title: "Large outflow", description: `$${outflowUsd.toFixed(2)} leaves the wallet, above policy.confirmAboveUsd.`, riskType: "CAUTION" });
  const reasons = risks.map((r) => `${r.riskType === "RISK" ? "risk" : "caution"}: ${r.title}`);
  const requireConfirmation = reasons.length > 0 && policy.abnormalTxnHandling === "NeedConfirmation";
  if (reasons.length && policy.abnormalTxnHandling === "AutoReject") {
    throw new WalletError("RISK_BLOCKED", "High risk transaction", { blockLevel: "Block", blockReason: reasons.join("; "), risks: { riskDetails: risks } });
  }
  const id = randomUUID();
  const result = {
    requestId: id,
    parsedTx: {
      transactionType: changes.some((c) => c.amount.startsWith("-")) ? "Spend" : "Interact",
      version: parsed.version,
      feePayer: parsed.feePayer,
      signers: parsed.signers,
      alreadySigned: parsed.alreadySigned,
      instructions: parsed.instructions,
      usesAddressLookupTables: parsed.usesAddressLookupTables,
      hasDurableNonce: parsed.hasDurableNonce,
    },
    simulationResult: {
      simulationCode: sim.err ? "FAILED" : "000000000",
      simulationErrorDetail: sim.err ? JSON.stringify(sim.err) : null,
      unitsConsumed: sim.unitsConsumed,
      balanceChanges: changes,
      allowanceChanges: parsed.authorityChanges.filter((a) => /Approve/.test(a.action)),
      authorityChanges: parsed.authorityChanges,
      logs: sim.logs.slice(-12),
      preCheckCode: "",
    },
    risks: { riskDetails: risks.map((r, i) => ({ ...r, order: i + 1 })), addresses: {}, riskBehaviors: [] },
    outflowUsd: Number(outflowUsd.toFixed(2)),
    requireConfirmation,
    expiresAt: Date.now() + PREVIEW_TTL,
    binanceChainId: CHAIN_ID,
  };
  previews.put({ id, kind: "contract-call", createdAt: Date.now(), expiresAt: result.expiresAt, usd: outflowUsd, reasons, payload: { unsignedTx }, result });
  return result;
}

// ---- messages ----

export type SignType = "SOLANA_OFFCHAIN" | "RAW";

function offchainContent(text: string) {
  const bytes = new TextEncoder().encode(text);
  const ascii = /^[\x20-\x7e]+$/.test(text); // kit's clear-signing rule: no newlines in the restricted format
  if (bytes.length <= 1232 && ascii) return { content: offchainMessageContentRestrictedAsciiOf1232BytesMax(text), format: "RESTRICTED_ASCII_1232" as const };
  if (bytes.length <= 1232) return { content: offchainMessageContentUtf8Of1232BytesMax(text), format: "UTF8_1232" as const };
  if (bytes.length <= 65535) return { content: offchainMessageContentUtf8Of65535BytesMax(text), format: "UTF8_65535" as const };
  throw new WalletError("INVALID_PARAM", "Message longer than 65535 bytes.");
}

export const DEFAULT_APP_DOMAIN = "11111111111111111111111111111111";

function looksLikeTransaction(bytes: Uint8Array): boolean {
  try {
    decodeMessage({ messageBytes: bytes } as never);
    return true;
  } catch {
    return false;
  }
}

export async function previewSignMessage(ctx: Ctx, message: string, signType: SignType, applicationDomain?: string) {
  assertDevMode();
  const wallet = await loadSigner();
  const risks: RiskItem[] = [];
  const bytes = new TextEncoder().encode(message);
  let parsedMessage: Record<string, unknown>;
  if (signType === "RAW") {
    if (looksLikeTransaction(bytes) || message.startsWith("\xffsolana offchain")) throw new WalletError("RISK_BLOCKED", "Refusing to raw-sign bytes that decode as a Solana transaction or off-chain envelope.");
    risks.push({ code: "RAW_SIGNATURE", title: "Raw byte signature", description: "Signs the bytes as-is (what most dApps' signMessage does). Only sign text you can read and that names this site.", riskType: "CAUTION" });
    parsedMessage = { messageType: "RawBytes", length: bytes.length, text: message.slice(0, 2000), preCheckCode: "" };
  } else {
    const dom = applicationDomain ?? DEFAULT_APP_DOMAIN;
    try {
      offchainMessageApplicationDomain(dom);
    } catch {
      throw new WalletError("INVALID_PARAM", "applicationDomain must be a base58 32-byte value.");
    }
    const { format } = offchainContent(message);
    parsedMessage = { messageType: "OffchainMessage", version: 0, applicationDomain: dom, format, length: bytes.length, text: message.slice(0, 2000), preCheckCode: "" };
  }
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(message);
  } catch {
    /* not json */
  }
  if (json && typeof json === "object") {
    for (const k of ["spender", "delegate", "authority", "newAuthority", "owner"]) if (k in json) risks.push({ code: "AUTHORITY_FIELD", title: `Message names a ${k}`, description: `${k}: ${String(json[k])}. Check this is who you intend to authorise.`, riskType: "CAUTION" });
  }
  const policy = readPolicy();
  const reasons = risks.map((r) => `${r.riskType === "RISK" ? "risk" : "caution"}: ${r.title}`);
  if (reasons.length && policy.abnormalTxnHandling === "AutoReject") throw new WalletError("RISK_BLOCKED", "High risk message", { risks });
  const id = randomUUID();
  const result = {
    requestId: id,
    parsedMessage,
    risks: { riskDetails: risks.map((r, i) => ({ ...r, order: i + 1 })), addresses: {}, riskBehaviors: [] },
    signer: wallet.address,
    requireConfirmation: reasons.length > 0,
    expiresAt: Date.now() + PREVIEW_TTL,
  };
  previews.put({ id, kind: "sign-message", createdAt: Date.now(), expiresAt: result.expiresAt, usd: 0, reasons, payload: { message, signType, applicationDomain: applicationDomain ?? null }, result });
  return result;
}

export async function signMessageNow(payload: { message: string; signType: SignType; applicationDomain: string | null }, orderId: string) {
  const wallet = await loadSigner();
  const b58 = getBase58Decoder();
  let sigBytes: Uint8Array;
  let envelopeBase64: string | null = null;
  if (payload.signType === "RAW") {
    sigBytes = new Uint8Array(await signBytes(wallet.keyPair.privateKey, new TextEncoder().encode(payload.message)));
  } else {
    const { content } = offchainContent(payload.message);
    const msg = {
      version: 0,
      applicationDomain: offchainMessageApplicationDomain(payload.applicationDomain ?? DEFAULT_APP_DOMAIN),
      requiredSignatories: [{ address: address(wallet.address) }],
      content,
    } as unknown as OffchainMessageV0;
    const env = compileOffchainMessageEnvelope(msg);
    const signed = await signOffchainMessageEnvelope([wallet.keyPair], env);
    sigBytes = new Uint8Array(signed.signatures[wallet.address as Address] as Uint8Array);
    envelopeBase64 = Buffer.from(getOffchainMessageEnvelopeEncoder().encode(signed)).toString("base64");
  }
  const signatureHash = b58.decode(sigBytes);
  const hex = Buffer.from(sigBytes).toString("hex");
  signatures.put({
    id: orderId,
    signatureType: payload.signType === "RAW" ? "raw_bytes" : "offchain_message",
    binanceChainId: CHAIN_ID,
    address: wallet.address,
    signatureHash,
    signatureHex: hex,
    signatureTime: Date.now(),
    messageType: payload.signType === "RAW" ? "RawBytes" : "OffchainMessage",
    applicationDomain: payload.signType === "RAW" ? null : payload.applicationDomain ?? DEFAULT_APP_DOMAIN,
    rawData: payload.message,
  });
  return { signature: hex, signatureBase58: signatureHash, publicKey: wallet.address, envelopeBase64 };
}

export function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}
export function fromB64(s: string): Uint8Array {
  return new Uint8Array(getBase64Encoder().encode(s));
}
