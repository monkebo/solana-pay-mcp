// Owner-side commands. Never reachable with an agent session token.
import { z } from "zod";
import { define, optNum, optStr, str } from "../core/registry.js";
import { readPolicy, patchPolicy } from "../core/policy.js";
import { activeSessions, approvePairing, pairings, rejectPairing, revokeAll } from "../core/session.js";
import { addContact, listContacts, removeContact } from "../core/addressbook.js";
import { keygen, hasKey, walletAddress } from "../core/signer.js";
import { keyPath } from "../core/config.js";
import { orders, pendingConfirmations, setOrder } from "../core/orders.js";
import { WalletError } from "../core/errors.js";
import { exec } from "../core/registry.js";
import { activeBackend, backendKinds, resetBackendCache, type BackendKind } from "../core/backend.js";
import { agents, runAsAgent } from "../core/agents.js";

define({
  name: "owner.keygen",
  cli: "owner keygen",
  title: "Create the wallet key",
  description: "Create the agent wallet keypair on this machine (0600). Fund it with a little SOL for fees plus the tokens the agent may spend.",
  access: "owner",
  write: true,
  params: {},
  async run() {
    const address = await keygen();
    return { address, path: keyPath(), next: "Fund it with ~0.01 SOL for fees. Then set policy with `saw owner set-policy` and add recipients with `saw owner add-contact`." };
  },
});

define({
  name: "owner.policy",
  cli: "owner policy",
  title: "Show policy",
  description: "Show the full security policy as stored.",
  access: "owner",
  write: false,
  params: {},
  async run() {
    return readPolicy();
  },
});

define({
  name: "owner.set-policy",
  cli: "owner set-policy",
  title: "Change policy",
  description: "Set policy fields: `saw owner set-policy dailyLimitUsd=200 addressBookOnly=false devMode.enabled=true`. Values are JSON (numbers, true/false, arrays) or plain strings.",
  access: "owner",
  write: true,
  positional: ["assignments[]"],
  params: { assignments: z.preprocess((v) => (typeof v === "string" ? [v] : v), z.array(z.string().regex(/^[A-Za-z0-9_.]+=.+$/, "field=value"))).describe("field=value pairs") },
  async run(_ctx, { assignments }) {
    const pairs: Record<string, string> = {};
    for (const a of assignments) {
      const i = a.indexOf("=");
      pairs[a.slice(0, i)] = a.slice(i + 1);
    }
    return patchPolicy(pairs);
  },
});

define({
  name: "owner.pairings",
  cli: "owner pairings",
  title: "Pending pairings",
  description: "Agents waiting for sign-in approval.",
  access: "owner",
  write: false,
  params: {},
  async run() {
    const now = Date.now();
    return pairings.all().filter((p) => p.status === "PENDING" && p.expireAt > now).map(({ token: _t, ...p }) => p);
  },
});

define({
  name: "owner.approve-pairing",
  cli: "owner approve-pairing",
  title: "Approve a pairing",
  description: "Approve an agent sign-in by the 6-digit code shown on the agent's screen.",
  access: "owner",
  write: true,
  positional: ["pairingCode"],
  params: { pairingCode: str("6-digit pairing code") },
  async run(_ctx, { pairingCode }) {
    const p = approvePairing(pairingCode);
    return { qrCodeId: p.id, status: p.status, label: p.label ?? null };
  },
});

define({
  name: "owner.reject-pairing",
  cli: "owner reject-pairing",
  title: "Reject a pairing",
  description: "Reject an agent sign-in request.",
  access: "owner",
  write: true,
  positional: ["pairingCode"],
  params: { pairingCode: str("6-digit pairing code") },
  async run(_ctx, { pairingCode }) {
    const p = rejectPairing(pairingCode);
    return { qrCodeId: p.id, status: p.status };
  },
});

define({
  name: "owner.sessions",
  cli: "owner sessions",
  title: "Active agent sessions",
  description: "List signed-in agents.",
  access: "owner",
  write: false,
  params: {},
  async run() {
    return activeSessions().map((s) => ({ id: s.id.slice(0, 12), label: s.label ?? null, createdAt: new Date(s.createdAt).toISOString(), lastActiveAt: new Date(s.lastActiveAt).toISOString(), expiresAt: new Date(s.expiresAt).toISOString() }));
  },
});

define({
  name: "owner.revoke-sessions",
  cli: "owner revoke-sessions",
  title: "Sign every agent out",
  description: "Revoke all agent sessions immediately.",
  access: "owner",
  write: true,
  params: {},
  async run() {
    return { revoked: revokeAll() };
  },
});

define({
  name: "owner.contacts",
  cli: "owner contacts",
  title: "Address book",
  description: "List saved recipients.",
  access: "owner",
  write: false,
  params: {},
  async run() {
    return listContacts();
  },
});

define({
  name: "owner.add-contact",
  cli: "owner add-contact",
  title: "Add a recipient",
  description: "Save a name for a wallet address. With policy.addressBookOnly the agent can only send to saved contacts.",
  access: "owner",
  write: true,
  params: { name: str("Short name, e.g. kevin"), address: str("Solana address") },
  async run(_ctx, { name, address }) {
    return addContact(name, address);
  },
});

define({
  name: "owner.remove-contact",
  cli: "owner remove-contact",
  title: "Remove a recipient",
  description: "Remove a saved contact.",
  access: "owner",
  write: true,
  params: { name: str("Contact name") },
  async run(_ctx, { name }) {
    removeContact(name);
    return { removed: name };
  },
});

define({
  name: "owner.pending",
  cli: "owner pending",
  title: "Orders awaiting confirmation",
  description: "Transactions the agent proposed that need the owner's approval.",
  access: "owner",
  write: false,
  params: {},
  async run() {
    return pendingConfirmations().map(({ action: _a, signedTx: _s, ...o }) => o);
  },
});

define({
  name: "owner.approve",
  cli: "owner approve",
  title: "Approve a pending order",
  description: "Execute an order that was waiting for confirmation.",
  access: "owner",
  write: true,
  positional: ["orderId"],
  params: { orderId: str("Order id from `owner pending`") },
  async run(ctx, { orderId }) {
    const o = orders.get(orderId);
    if (!o || o.status !== "PENDING_CONFIRMATION" || !o.action) throw new WalletError("TARGET_NOT_FOUND", `No order ${orderId} awaiting confirmation.`);
    if (o.expiresAt !== undefined && o.expiresAt < Date.now()) {
      setOrder(o.id, { status: "EXPIRED", action: undefined });
      throw new WalletError("PREVIEW_EXPIRED", `Order ${orderId} expired before approval. Ask the agent to submit it again.`);
    }
    const result = await runAsAgent(o.agentId ? agents.get(o.agentId) : undefined, () => exec({ ...ctx, role: "owner", approved: true }, o.action!.command, { ...o.action!.params, orderId: o.id }));
    return { orderId: o.id, result };
  },
});

define({
  name: "owner.reject",
  cli: "owner reject",
  title: "Reject a pending order",
  description: "Reject an order that was waiting for confirmation.",
  access: "owner",
  write: true,
  positional: ["orderId"],
  params: { orderId: str("Order id"), reason: optStr("Optional reason shown to the agent") },
  async run(_ctx, { orderId, reason }) {
    const o = orders.get(orderId);
    if (!o || o.status !== "PENDING_CONFIRMATION") throw new WalletError("TARGET_NOT_FOUND", `No order ${orderId} awaiting confirmation.`);
    return setOrder(o.id, { status: "REJECTED", action: undefined, error: reason ?? "rejected by owner" });
  },
});

define({
  name: "owner.status",
  cli: "owner status",
  title: "Owner overview",
  description: "Key presence, address, active sessions, pending confirmations.",
  access: "owner",
  write: false,
  params: {},
  async run() {
    return {
      hasKey: hasKey(),
      address: hasKey() ? await walletAddress() : null,
      keyPath: keyPath(),
      sessions: activeSessions().length,
      pendingConfirmations: pendingConfirmations().length,
      pendingPairings: pairings.all().filter((p) => p.status === "PENDING" && p.expireAt > Date.now()).length,
    };
  },
});

define({
  name: "owner.backends",
  cli: "owner backends",
  title: "Wallet backends",
  description: "Which wallets this control plane can execute through, and which one is active.",
  access: "owner",
  write: false,
  params: {},
  async run(ctx) {
    const p = readPolicy();
    const be = activeBackend();
    const st = await be.status(ctx).catch((e: Error) => ({ connected: false, detail: e.message }));
    return { active: { kind: be.kind, label: be.label, canSign: be.canSign, ...st, config: p.backend }, available: backendKinds() };
  },
});

define({
  name: "owner.set-backend",
  cli: "owner set-backend",
  title: "Switch wallet backend",
  description: "Route every agent command to a different wallet: local (self-custody key), baw (Binance Agentic Wallet CLI), signer (HTTP remote signer: --url, --token, --address), solana-pay (a human's wallet: --address). Agents keep working unchanged.",
  access: "owner",
  write: true,
  params: { kind: z.enum(["local", "baw", "signer", "solana-pay"]), url: optStr("signer: base URL"), token: optStr("signer: bearer token"), address: optStr("signer/solana-pay: wallet address"), bin: optStr("baw: path to the baw binary"), label: optStr("solana-pay: label") },
  async run(ctx, { kind, url, token, address: addr, bin, label }) {
    const cfg: Record<string, unknown> = { kind: kind as BackendKind };
    if (kind === "signer") {
      if (!url) throw new WalletError("MISSING_PARAM", "--url is required for the signer backend.");
      cfg.signer = { url, token, address: addr };
    }
    if (kind === "solana-pay") {
      if (!addr) throw new WalletError("MISSING_PARAM", "--address is required for the solana-pay backend.");
      cfg.solanaPay = { address: addr, label };
    }
    if (kind === "baw") cfg.baw = { bin: bin ?? "baw" };
    patchPolicy({ backend: JSON.stringify(cfg) });
    resetBackendCache();
    const be = activeBackend();
    const st = await be.status(ctx).catch((e: Error) => ({ connected: false, detail: e.message }));
    return { active: be.kind, label: be.label, ...st };
  },
});
