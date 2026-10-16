import { z } from "zod";
import { define, optStr, str } from "../core/registry.js";
import { WalletError } from "../core/errors.js";
import { readPolicy } from "../core/policy.js";
import { approvePairing, authenticate, pairings, pollPairing, revoke, startPairing } from "../core/session.js";

define({
  name: "auth.signin",
  cli: "auth signin",
  title: "Start sign-in",
  description: "Start the agent sign-in. Shows a 6-digit pairing code the owner approves (vault UI or `saw owner approve-pairing`). Follow with `auth verify`.",
  access: "public",
  write: false,
  params: { label: optStr("Optional label for this agent session, e.g. 'claude-code laptop'") },
  async run(ctx, { label }) {
    try {
      if (ctx.token) {
        authenticate(ctx.token);
        return { status: "ALREADY_CONNECTED" };
      }
    } catch {
      /* fall through to a fresh pairing */
    }
    const p = startPairing(label);
    const base = ctx.vaultUrl ?? process.env.SAW_VAULT_URL ?? null;
    return {
      qrCodeId: p.id,
      pairingCode: p.pairingCode,
      expireAt: String(p.expireAt),
      urlForWeb: base ? `${base.replace(/\/$/, "")}/pair?code=${p.pairingCode}` : null,
      approveCommand: `saw owner approve-pairing --pairingCode ${p.pairingCode}`,
      autoApprove: !readPolicy().requirePairingApproval,
    };
  },
});

define({
  name: "auth.verify",
  cli: "auth verify",
  title: "Verify sign-in",
  description: "Poll the pairing started by `auth signin`. Blocks until the owner approves (or 5 minutes). On success returns the session token once; the CLI/MCP client stores it.",
  access: "public",
  write: false,
  params: { qrCodeId: str("qrCodeId from `auth signin`"), wait: z.preprocess((v) => v === "true" || v === true, z.boolean()).optional() },
  async run(ctx, { qrCodeId, wait }) {
    const pol = readPolicy();
    const once = () => {
      let r = pollPairing(qrCodeId);
      if (r.status === "PENDING" && !pol.requirePairingApproval) {
        // Local mode: the agent runs on the owner's own machine; nothing to pair with. Approve inline.
        const code = pairings.get(qrCodeId)?.pairingCode;
        if (code) approvePairing(code);
        r = pollPairing(qrCodeId);
      }
      return r;
    };
    const deadline = Date.now() + Number(process.env.SAW_VERIFY_TIMEOUT_MS ?? 5 * 60 * 1000);
    let r = once();
    while (r.status === "PENDING" && wait !== false && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 1000));
      r = once();
    }
    if (r.status === "APPROVED" && r.token) {
      return { status: "SUCCESS", token: r.token };
    }
    if (r.status === "PENDING") throw new WalletError("AUTH_PENDING", "Still waiting for the owner to approve the pairing code. Run `auth verify` again or ask the owner to approve.");
    throw new WalletError("AUTH_REJECTED", "QR code does not exist or expired, please try a new code or restart the log in process.");
  },
});


define({
  name: "auth.signout",
  cli: "auth signout",
  title: "Sign out",
  description: "Sign out of the wallet and clear the local session. The agent loses all access until the owner approves a new pairing.",
  access: "public",
  write: false,
  params: {},
  async run(ctx) {
    revoke(ctx.token);
    return { status: "LOGGED_OUT" };
  },
});
