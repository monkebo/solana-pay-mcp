// Pure logic: Solana Pay URLs and paid-detection. No I/O, so it is unit-testable.

export type Cluster = "devnet" | "mainnet";

export const USDC_MINT: Record<Cluster, string> = {
  devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  mainnet: "EPjFWdd5AufqSSqeM2qN1xqybapC8G4wEGGkZwyTDt1v",
};
export const USDC_DECIMALS = 6;

export interface PaymentRequest {
  id: string;
  kind: "invoice" | "payment";
  recipient: string; // wallet that must receive the USDC
  amount: string; // decimal string, e.g. "3000" or "12.50"
  memo: string;
  reference: string; // fresh public key, attached to the tx so we can find it
  cluster: Cluster;
  createdAt: string;
  paidTx?: string;
  paidAt?: string;
  matchedBy?: "reference" | "inflow";
}

/** Solana Pay transfer-request URL. Any wallet (Phantom, Solflare, Backpack) opens it. */
export function solanaPayUrl(req: PaymentRequest, label = "solana-pay-mcp"): string {
  const q = new URLSearchParams({
    amount: req.amount,
    "spl-token": USDC_MINT[req.cluster],
    reference: req.reference,
    label,
    message: req.memo,
    memo: req.id,
  });
  return `solana:${req.recipient}?${q.toString()}`;
}

/** "12.5" -> 12500000n. Rejects more than 6 decimals or non-numeric input. */
export function toBaseUnits(amount: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(amount.trim());
  if (!m) throw new Error(`bad USDC amount: ${amount}`);
  const whole = m[1];
  const frac = (m[2] ?? "").padEnd(USDC_DECIMALS, "0");
  return BigInt(whole) * 10n ** BigInt(USDC_DECIMALS) + BigInt(frac);
}

export function fromBaseUnits(units: bigint): string {
  const s = units.toString().padStart(USDC_DECIMALS + 1, "0");
  const whole = s.slice(0, -USDC_DECIMALS);
  const frac = s.slice(-USDC_DECIMALS).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** Minimal shape of getTransaction(...).meta token balances we rely on. */
export interface TokenBalanceLike {
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string };
}
export interface TxMetaLike {
  err: unknown;
  preTokenBalances?: readonly TokenBalanceLike[] | null;
  postTokenBalances?: readonly TokenBalanceLike[] | null;
}

/**
 * How much USDC (base units) did `recipient` gain in this transaction?
 * Sums all of the owner's token accounts for the mint, post minus pre.
 */
export function usdcReceived(meta: TxMetaLike, recipient: string, mint: string): bigint {
  if (meta.err) return 0n;
  const sum = (list?: readonly TokenBalanceLike[] | null) =>
    (list ?? [])
      .filter((b) => b.mint === mint && b.owner === recipient)
      .reduce((acc, b) => acc + BigInt(b.uiTokenAmount.amount), 0n);
  return sum(meta.postTokenBalances) - sum(meta.preTokenBalances);
}

export function isPaid(meta: TxMetaLike, req: PaymentRequest): boolean {
  return usdcReceived(meta, req.recipient, USDC_MINT[req.cluster]) >= toBaseUnits(req.amount);
}
