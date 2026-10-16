// Address book. Owner-managed (like the Binance App → Settings → Address Book). Agents can read, resolve, never write.
import { address, type Address } from "@solana/kit";
import { Collection } from "./store.js";
import { WalletError } from "./errors.js";
import { readPolicy } from "./policy.js";

export interface Contact {
  id: string; // lowercase name
  name: string;
  address: string;
  addedAt: number;
}

export const contacts = new Collection<Contact>("contacts-v2");

export function addContact(name: string, addr: string): Contact {
  const id = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9 ._()#-]{0,31}$/.test(id)) throw new WalletError("INVALID_PARAM", "Contact names: 1–32 chars, letters/digits/space/. _ - ( ) #, starting with a letter or digit.");
  return contacts.put({ id, name: name.trim(), address: address(addr), addedAt: Date.now() });
}

export function removeContact(name: string): void {
  const id = name.trim().toLowerCase();
  if (!contacts.get(id)) throw new WalletError("TARGET_NOT_FOUND", `No contact named ${name}.`);
  contacts.remove(id);
}

export function listContacts(): Contact[] {
  return contacts.all().sort((a, b) => a.id.localeCompare(b.id));
}

export function findByAddress(addr: string): Contact | undefined {
  return contacts.all().find((c) => c.address === addr);
}

/**
 * Resolve a recipient: saved name or raw address. Enforces policy.addressBookOnly.
 * Names are never taken from on-chain data; only from the user's instruction.
 */
export function resolveRecipient(nameOrAddress: string): { address: Address; label: string | null } {
  const hit = contacts.get(nameOrAddress.trim().toLowerCase());
  if (hit) return { address: address(hit.address), label: hit.name };
  let a: Address;
  try {
    a = address(nameOrAddress.trim());
  } catch {
    throw new WalletError("TARGET_NOT_FOUND", `"${nameOrAddress}" is neither a saved contact nor a valid Solana address.`);
  }
  const known = findByAddress(a);
  if (known) return { address: a, label: known.name };
  if (readPolicy().addressBookOnly) {
    throw new WalletError(
      "RECIPIENT_NOT_IN_ADDRESS_BOOK",
      `${a} is not in the address book and policy.addressBookOnly is on. The owner can add it with \`saw owner add-contact --name <name> --address ${a}\`.`,
      { address: a },
    );
  }
  return { address: a, label: null };
}
