// The local keypair file (backend "local"). Lives on the vault host; agents never see it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createKeyPairSignerFromBytes, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, type Address, type KeyPairSigner } from "@solana/kit";
import { keyPath } from "./config.js";
import { WalletError } from "./errors.js";

export function hasKey(): boolean {
  return existsSync(keyPath());
}

/** Write a new keypair (0600) in `solana-keygen` layout and return its address. Never prints the secret. */
export async function keygen(path = keyPath()): Promise<Address> {
  if (existsSync(path)) throw new WalletError("BAD_REQUEST", `${path} already exists; refusing to overwrite a key`);
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const kp = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const pub = new Uint8Array(getAddressEncoder().encode(kp.address));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(Array.from([...seed, ...pub])), { mode: 0o600 });
  return kp.address;
}

let cached: { path: string; signer: KeyPairSigner } | undefined;

export async function loadLocalSigner(): Promise<KeyPairSigner> {
  const p = keyPath();
  if (cached?.path === p) return cached.signer;
  if (!existsSync(p)) throw new WalletError("NO_WALLET", `No wallet key at ${p}. The owner creates one with \`saw owner keygen\`.`);
  const bytes = Uint8Array.from(JSON.parse(readFileSync(p, "utf8")) as number[]);
  const signer = await createKeyPairSignerFromBytes(bytes);
  cached = { path: p, signer };
  return signer;
}

export async function localAddress(): Promise<Address> {
  return (await loadLocalSigner()).address;
}
