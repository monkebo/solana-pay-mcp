// Receiving: invoices with a fresh reference key each, settlement detection with an explicit confidence label,
// and a ledger that can be rebuilt from the chain alone.
import { randomUUID } from "node:crypto";
import { address, type Address, type Signature } from "@solana/kit";
import type { Ctx } from "./ctx.js";
import { Collection } from "./store.js";
import { cluster, explorerUrl } from "./config.js";
import { newReference, solanaPayUrl, toBaseUnits, usdcReceived, type PaymentRequest } from "./pay.js";
import { USDC_MINT } from "./tokens.js";
import { walletAddress } from "./signer.js";
import { WalletError } from "./errors.js";
import { findByAddress } from "./addressbook.js";

export interface Invoice extends PaymentRequest {
  /** confirmed = seen at confirmed commitment; settled = finalized. */
  settlement?: "confirmed" | "settled";
  confidence?: "exact" | "probable";
  payer?: string | null;
  payerLabel?: string | null;
  amountReceived?: string;
}

export const invoices = new Collection<Invoice>("invoices");

export async function invoiceRecipient(): Promise<Address> {
  const env = process.env.SOLANA_PAY_RECIPIENT;
  return env ? address(env) : walletAddress();
}

export async function createInvoice(amount: string, memo: string): Promise<Invoice> {
  toBaseUnits(amount); // validates USDC precision
  const inv: Invoice = {
    id: `inv_${randomUUID().slice(0, 8)}`,
    kind: "invoice",
    recipient: await invoiceRecipient(),
    amount,
    memo,
    reference: await newReference(),
    cluster: cluster(),
    createdAt: new Date().toISOString(),
  };
  invoices.put(inv);
  return inv;
}

interface Found {
  tx: string;
  blockTime: number | null;
  matchedBy: "reference" | "inflow";
  payer: string | null;
  received: bigint;
  finalized: boolean;
}

async function scan(ctx: Ctx, req: PaymentRequest, account: string, limit: number, notBefore: number): Promise<Found | null> {
  const sigs = await ctx.rpc.getSignaturesForAddress(address(account), { limit }).send();
  for (const s of sigs) {
    if (s.blockTime !== null && Number(s.blockTime) < notBefore) break;
    const tx = (await ctx.rpc.getTransaction(s.signature as Signature, { maxSupportedTransactionVersion: 1, encoding: "jsonParsed" }).send()) as unknown as {
      meta: Parameters<typeof usdcReceived>[0] & { preTokenBalances?: { mint: string; owner?: string; uiTokenAmount: { amount: string } }[] | null; postTokenBalances?: { mint: string; owner?: string; uiTokenAmount: { amount: string } }[] | null };
      blockTime: bigint | number | null;
    } | null;
    if (!tx?.meta || tx.meta.err) continue;
    const mint = USDC_MINT[req.cluster];
    const received = usdcReceived(tx.meta, req.recipient, mint);
    if (received < toBaseUnits(req.amount)) continue;
    // payer: the other owner of the same mint whose balance went down
    let payer: string | null = null;
    const pre = new Map<string, bigint>();
    for (const b of tx.meta.preTokenBalances ?? []) if (b.mint === mint && b.owner && b.owner !== req.recipient) pre.set(b.owner, (pre.get(b.owner) ?? 0n) + BigInt(b.uiTokenAmount.amount));
    for (const b of tx.meta.postTokenBalances ?? []) if (b.mint === mint && b.owner && b.owner !== req.recipient) {
      const d = BigInt(b.uiTokenAmount.amount) - (pre.get(b.owner) ?? 0n);
      if (d < 0n) payer = b.owner;
    }
    return { tx: s.signature, blockTime: tx.blockTime === null ? null : Number(tx.blockTime), matchedBy: account === req.reference ? "reference" : "inflow", payer, received, finalized: s.confirmationStatus === "finalized" };
  }
  return null;
}

/**
 * 1. Exact: a transaction carrying the invoice's reference key.
 * 2. Probable: a USDC inflow of at least the amount after the invoice was created (wallets that drop the reference).
 */
export async function findPayment(ctx: Ctx, req: PaymentRequest): Promise<Found | null> {
  const createdAt = Math.floor(Date.parse(req.createdAt) / 1000) - 60;
  return (await scan(ctx, req, req.reference, 20, 0)) ?? (await scan(ctx, req, req.recipient, 50, createdAt));
}

export async function refreshInvoice(ctx: Ctx, id: string): Promise<Invoice> {
  const inv = invoices.get(id);
  if (!inv) throw new WalletError("TARGET_NOT_FOUND", `No invoice ${id}.`);
  if (inv.settlement === "settled") return inv;
  const found = await findPayment(ctx, inv);
  if (!found) return inv;
  const payerLabel = found.payer ? findByAddress(found.payer)?.name ?? null : null;
  return invoices.put({
    ...inv,
    paidTx: found.tx,
    paidAt: found.blockTime ? new Date(found.blockTime * 1000).toISOString() : inv.paidAt ?? new Date().toISOString(),
    matchedBy: found.matchedBy,
    confidence: found.matchedBy === "reference" ? "exact" : "probable",
    settlement: found.finalized ? "settled" : "confirmed",
    payer: found.payer,
    payerLabel,
    amountReceived: (Number(found.received) / 1e6).toString(),
  });
}

export function invoiceView(inv: Invoice) {
  return {
    ...inv,
    url: solanaPayUrl(inv),
    paid: Boolean(inv.paidTx),
    explorer: inv.paidTx ? explorerUrl(inv.paidTx) : null,
    status: inv.settlement === "settled" ? "SETTLED" : inv.paidTx ? "CONFIRMED" : "UNPAID",
  };
}

/** Rebuild every invoice's settlement from the chain, ignoring cached state. Proof that the ledger is not ours to fake. */
export async function rebuildFromChain(ctx: Ctx): Promise<{ checked: number; changed: number }> {
  let changed = 0;
  const all = invoices.all();
  for (const inv of all) {
    const before = JSON.stringify(inv);
    invoices.put({ ...inv, paidTx: undefined, paidAt: undefined, matchedBy: undefined, settlement: undefined, confidence: undefined, payer: undefined, payerLabel: undefined, amountReceived: undefined });
    const after = await refreshInvoice(ctx, inv.id);
    if (JSON.stringify(after) !== before) changed++;
  }
  return { checked: all.length, changed };
}
