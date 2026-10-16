// Facade over the active backend, so every module asks "who is the wallet" and "sign this" the same way
// whether the key is local, in Binance's wallet, behind an HTTP custodian, or in a human's phone.
import type { Address } from "@solana/kit";
import { activeBackend, type WalletSigner } from "./backend.js";

export { hasKey, keygen } from "./keys.js";

export async function walletAddress(): Promise<Address> {
  return activeBackend().address();
}

/** A kit signer for the active backend. Throws NOT_SUPPORTED for backends that only execute whole operations. */
export async function loadSigner(): Promise<WalletSigner> {
  return activeBackend().signer();
}
