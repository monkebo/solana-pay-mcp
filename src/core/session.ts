// Agent sign-in. Mirrors `baw auth signin → verify → signout`:
//   signin  → pairing { qrCodeId, pairingCode, urlForWeb, expireAt }
//   verify  → blocks until the owner approves the pairing (vault mode) or auto-approves (local mode); stores a session token
//   signout → revokes the session
// Sessions expire after policy.maxSigninDuration and after policy.inactiveSignoutDuration without activity.
import { createHash, randomBytes, randomInt } from "node:crypto";
import { Collection, Doc } from "./store.js";
import { parseDuration } from "./config.js";
import { WalletError } from "./errors.js";
import { readPolicy } from "./policy.js";

export interface Pairing {
  id: string; // qrCodeId
  pairingCode: string;
  createdAt: number;
  expireAt: number;
  status: "PENDING" | "APPROVED" | "REJECTED";
  label?: string;
  /** Plain token, present only between approval and the agent's `verify` pickup. */
  token?: string;
}

export interface Session {
  id: string; // sha256(token)
  label?: string;
  createdAt: number;
  lastActiveAt: number;
  expiresAt: number;
  inactiveSignOutAt: number;
}

export const pairings = new Collection<Pairing>("pairings");
export const sessions = new Collection<Session>("sessions");
/** The agent's own copy of its token (client side). */
export const localSession = new Doc<{ token: string | null; vaultUrl: string | null }>("session", () => ({ token: null, vaultUrl: null }));

export const PAIRING_TTL = 5 * 60 * 1000;

export function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function startPairing(label?: string): Pairing {
  const now = Date.now();
  const p: Pairing = {
    id: crypto.randomUUID(),
    pairingCode: String(randomInt(0, 1_000_000)).padStart(6, "0"),
    createdAt: now,
    expireAt: now + PAIRING_TTL,
    status: "PENDING",
    label,
  };
  pairings.put(p);
  // Keep the file small.
  for (const old of pairings.all()) if (old.expireAt < now - PAIRING_TTL) pairings.remove(old.id);
  return p;
}

/** Owner side: approve by pairing code (what the human sees on the agent's screen). Issues the session token. */
export function approvePairing(pairingCode: string): Pairing {
  const p = pairings.all().find((x) => x.pairingCode === pairingCode && x.status === "PENDING");
  if (!p) throw new WalletError("TARGET_NOT_FOUND", `No pending pairing with code ${pairingCode}.`);
  if (p.expireAt < Date.now()) throw new WalletError("AUTH_REJECTED", "Pairing code expired. Run `auth signin` again.");
  const token = randomBytes(32).toString("hex");
  const pol = readPolicy();
  const now = Date.now();
  sessions.put({
    id: hash(token),
    label: p.label,
    createdAt: now,
    lastActiveAt: now,
    expiresAt: now + parseDuration(pol.maxSigninDuration),
    inactiveSignOutAt: now + parseDuration(pol.inactiveSignoutDuration),
  });
  return pairings.put({ ...p, status: "APPROVED", token });
}

export function rejectPairing(pairingCode: string): Pairing {
  const p = pairings.all().find((x) => x.pairingCode === pairingCode && x.status === "PENDING");
  if (!p) throw new WalletError("TARGET_NOT_FOUND", `No pending pairing with code ${pairingCode}.`);
  return pairings.put({ ...p, status: "REJECTED" });
}

/** Agent side: one poll of the pairing. Returns the token once, then forgets it. */
export function pollPairing(qrCodeId: string): { status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED"; token?: string } {
  const p = pairings.get(qrCodeId);
  if (!p) return { status: "EXPIRED" };
  if (p.status === "PENDING" && p.expireAt < Date.now()) return { status: "EXPIRED" };
  if (p.status === "APPROVED" && p.token) {
    const token = p.token;
    pairings.put({ ...p, token: undefined });
    return { status: "APPROVED", token };
  }
  return { status: p.status };
}

/** Validate a bearer token, enforce expiry and inactivity, touch lastActiveAt. */
export function authenticate(token: string | null | undefined): Session {
  if (!token) throw new WalletError("NOT_SIGNED_IN", "Not signed in. Run `auth signin`, then `auth verify --qrCodeId <id>`.");
  const s = sessions.get(hash(token));
  const now = Date.now();
  if (!s) throw new WalletError("NOT_SIGNED_IN", "Session not found or revoked. Run `auth signin` again.");
  if (s.expiresAt < now || s.inactiveSignOutAt < now) {
    sessions.remove(s.id);
    throw new WalletError("SESSION_EXPIRED", "Session expired (max sign-in duration or inactivity). Run `auth signin` again.");
  }
  const pol = readPolicy();
  return sessions.put({ ...s, lastActiveAt: now, inactiveSignOutAt: now + parseDuration(pol.inactiveSignoutDuration) });
}

export function revoke(token: string | null | undefined): boolean {
  if (!token) return false;
  const s = sessions.get(hash(token));
  if (s) sessions.remove(s.id);
  return Boolean(s);
}

export function revokeAll(): number {
  const n = sessions.all().length;
  sessions.write([]);
  return n;
}

export function activeSessions(): Session[] {
  const now = Date.now();
  return sessions.all().filter((s) => s.expiresAt >= now && s.inactiveSignOutAt >= now);
}
