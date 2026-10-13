// Chain I/O. Read-only: this server never holds a private key.
import { address, createSolanaRpc, generateKeyPairSigner, type Address } from "@solana/kit";
import { type Cluster, type PaymentRequest, USDC_MINT, fromBaseUnits, isPaid } from "./pay.js";

export function cluster(): Cluster {
  const c = process.env.SOLANA_CLUSTER ?? "devnet";
  if (c !== "devnet" && c !== "mainnet") throw new Error(`SOLANA_CLUSTER must be devnet|mainnet, got ${c}`);
  return c;
}

export function rpcUrl(): string {
  return (
    process.env.SOLANA_RPC_URL ??
    (cluster() === "mainnet" ? "https://api.mainnet-beta.solana.com" : "https://api.devnet.solana.com")
  );
}

export function recipient(): Address {
  const r = process.env.SOLANA_PAY_RECIPIENT;
  if (!r) throw new Error("Set SOLANA_PAY_RECIPIENT to the wallet address that receives USDC.");
  return address(r);
}

/** A reference is just a fresh public key. The secret is thrown away; only the address matters. */
export async function newReference(): Promise<string> {
  const kp = await generateKeyPairSigner();
  return kp.address;
}

const rpc = () => createSolanaRpc(rpcUrl());

type Found = { tx: string; blockTime: number | null; matchedBy: "reference" | "inflow" };

async function scan(req: PaymentRequest, account: string, limit: number, notBefore: number): Promise<Found | null> {
  const r = rpc();
  const sigs = await r.getSignaturesForAddress(address(account), { limit }).send();
  for (const s of sigs) {
    if (s.blockTime !== null && Number(s.blockTime) < notBefore) break; // list is newest first
    const tx = await r
      .getTransaction(s.signature, { maxSupportedTransactionVersion: 1, encoding: "jsonParsed" })
      .send();
    if (tx?.meta && isPaid(tx.meta, req)) {
      return {
        tx: s.signature,
        blockTime: tx.blockTime === null ? null : Number(tx.blockTime),
        matchedBy: account === req.reference ? "reference" : "inflow",
      };
    }
  }
  return null;
}

/**
 * 1. Exact: a transaction that carries the request's reference key (wallets that honour Solana Pay).
 * 2. Fallback: any USDC inflow to the recipient of at least the amount, after the request was created
 *    (wallets that drop the reference, or a manual transfer). Labelled "inflow" so the caller can say so.
 */
export async function findPayment(req: PaymentRequest): Promise<Found | null> {
  const createdAt = Math.floor(Date.parse(req.createdAt) / 1000) - 60;
  return (await scan(req, req.reference, 20, 0)) ?? (await scan(req, req.recipient, 50, createdAt));
}

export function explorerUrl(tx: string): string {
  const c = cluster();
  return `https://explorer.solana.com/tx/${tx}${c === "devnet" ? "?cluster=devnet" : ""}`;
}

/** SOL and USDC balance of an owner, as decimal strings. */
export async function balances(owner: string): Promise<{ sol: string; usdc: string }> {
  const r = rpc();
  const lamports = (await r.getBalance(address(owner)).send()).value;
  const accts = await r
    .getTokenAccountsByOwner(address(owner), { mint: address(USDC_MINT[cluster()]) }, { encoding: "jsonParsed" })
    .send();
  const units = accts.value.reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n);
  return { sol: fromBaseUnits(lamports, 9), usdc: fromBaseUnits(units) };
}
