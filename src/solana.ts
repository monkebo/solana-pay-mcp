// Chain I/O. Read-only: this server never holds a private key.
import { address, createSolanaRpc, generateKeyPairSigner, type Address } from "@solana/kit";
import { type Cluster, type PaymentRequest, isPaid } from "./pay.js";

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

/** Scan transactions that mention the reference key; return the first one that pays the request. */
export async function findPayment(req: PaymentRequest): Promise<{ tx: string; blockTime: number | null } | null> {
  const r = rpc();
  const sigs = await r.getSignaturesForAddress(address(req.reference), { limit: 20 }).send();
  for (const s of sigs) {
    const tx = await r
      .getTransaction(s.signature, { maxSupportedTransactionVersion: 1, encoding: "jsonParsed" })
      .send();
    if (tx?.meta && isPaid(tx.meta, req)) {
      return { tx: s.signature, blockTime: tx.blockTime === null ? null : Number(tx.blockTime) };
    }
  }
  return null;
}

export function explorerUrl(tx: string): string {
  const c = cluster();
  return `https://explorer.solana.com/tx/${tx}${c === "devnet" ? "?cluster=devnet" : ""}`;
}
