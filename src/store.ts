// ponytail: JSON file store. Swap for Postgres when there is more than one user.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PaymentRequest } from "./pay.js";

const DIR = process.env.SOLANA_PAY_MCP_HOME ?? join(homedir(), ".solana-pay-mcp");
const FILE = join(DIR, "requests.json");

function load(): PaymentRequest[] {
  if (!existsSync(FILE)) return [];
  return JSON.parse(readFileSync(FILE, "utf8")) as PaymentRequest[];
}

function save(list: PaymentRequest[]): void {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  writeFileSync(FILE, JSON.stringify(list, null, 2), { mode: 0o600 });
}

export function put(req: PaymentRequest): void {
  const list = load().filter((r) => r.id !== req.id);
  list.push(req);
  save(list);
}

export function get(id: string): PaymentRequest | undefined {
  return load().find((r) => r.id === id);
}

export function all(): PaymentRequest[] {
  return load();
}
