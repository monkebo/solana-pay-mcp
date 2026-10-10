// Address book: "kevin" -> wallet address. Plain JSON next to requests.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { address, type Address } from "@solana/kit";

const FILE = join(process.env.SOLANA_PAY_MCP_HOME ?? join(homedir(), ".solana-pay-mcp"), "contacts.json");

export function all(): Record<string, string> {
  return existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Record<string, string>) : {};
}

export function save(name: string, addr: string): void {
  const c = all();
  c[name.trim().toLowerCase()] = address(addr);
  mkdirSync(dirname(FILE), { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
}

/** Accepts a saved name or a raw address. */
export function resolve(nameOrAddress: string): Address {
  const hit = all()[nameOrAddress.trim().toLowerCase()];
  if (hit) return address(hit);
  try {
    return address(nameOrAddress);
  } catch {
    throw new Error(`Unknown contact "${nameOrAddress}". Save it first with add_contact.`);
  }
}
