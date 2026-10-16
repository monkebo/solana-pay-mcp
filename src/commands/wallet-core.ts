import { z } from "zod";
import { define } from "../core/registry.js";
import { CHAINS, CHAIN_ID, CLI_VERSION, SKILL_NAME, nowMs } from "../core/config.js";
import { authenticate } from "../core/session.js";
import { walletAddress } from "../core/signer.js";
import { readPolicy } from "../core/policy.js";
import { quotaView, lockingOrders } from "../core/orders.js";
import { refreshPending } from "../core/track.js";
import { listContacts } from "../core/addressbook.js";
import { activeBackend } from "../core/backend.js";
import { currentAgent } from "../core/agents.js";

define({
  name: "wallet.status",
  cli: "wallet status",
  title: "Connection status",
  description: "UNCONNECTED (not signed in), CREATING (signed in, no key yet), CONNECTED (ready).",
  access: "public",
  write: false,
  params: {},
  async run(ctx) {
    try {
      authenticate(ctx.token);
    } catch {
      if (ctx.role !== "owner") return { status: "UNCONNECTED" };
    }
    const be = activeBackend();
    const st = await be.status(ctx);
    return { status: st.connected ? "CONNECTED" : "CREATING", backend: be.kind, backendLabel: be.label, detail: st.detail };
  },
});

define({
  name: "wallet.whoami",
  cli: "wallet whoami",
  title: "Which agent am I",
  description: "The fleet agent this session acts as (name, role, address, status) or the single default wallet.",
  access: "session",
  write: false,
  params: {},
  async run() {
    const a = currentAgent();
    return a ? { agent: { id: a.id, name: a.name, role: a.role, status: a.status }, address: a.address } : { agent: null, address: await walletAddress() };
  },
});

define({
  name: "wallet.chains",
  cli: "wallet chains",
  title: "Supported chains",
  description: "Networks this wallet supports. One: Solana (CT_501), mainnet or devnet per SOLANA_CLUSTER.",
  access: "public",
  write: false,
  params: {},
  async run() {
    return CHAINS;
  },
});

define({
  name: "wallet.address",
  cli: "wallet address",
  title: "Wallet address",
  description: "The agent wallet's address.",
  access: "session",
  write: false,
  params: {},
  async run() {
    return { addresses: [{ binanceChainId: CHAIN_ID, chainName: "Solana", address: await walletAddress() }] };
  },
});

define({
  name: "wallet.settings",
  cli: "wallet settings",
  title: "Security settings and quotas",
  description: "Read-only view of the policy and remaining daily quotas. Settings change only on the owner side.",
  access: "session",
  write: false,
  params: {},
  async run(ctx) {
    const p = readPolicy();
    const g = quotaView(p, "general");
    const x = quotaView(p, "x402");
    const s = ctx.session;
    return {
      maxSigninDuration: p.maxSigninDuration,
      inactiveSignoutDuration: p.inactiveSignoutDuration,
      dailyLimit: p.dailyLimitUsd,
      maxPayment: p.maxPaymentUsd,
      confirmAbove: p.confirmAboveUsd,
      abnormalTxnHandling: p.abnormalTxnHandling,
      tradeAllTokens: p.tradeAllTokens,
      allowedTokens: p.allowedTokens,
      addressBookOnly: p.addressBookOnly,
      allowUnpricedTokens: p.allowUnpricedTokens,
      x402DailyLimit: p.x402DailyLimitUsd,
      x402QuotaUsed: x.used,
      x402QuotaLeft: x.left,
      x402QuotaDate: x.date,
      quotaUsed: g.used,
      quotaLeft: g.left,
      quotaDate: g.date,
      inactiveSignOutTime: s ? new Date(s.inactiveSignOutAt).toISOString() : null,
      sessionExpireTime: s ? new Date(s.expiresAt).toISOString() : null,
    };
  },
});

define({
  name: "wallet.tx-lock",
  cli: "wallet tx-lock",
  title: "Transaction lock",
  description: "LOCKED while a transaction is pending on-chain or an order waits for owner confirmation; UNLOCKED otherwise.",
  access: "session",
  write: false,
  params: { binanceChainId: z.string().optional() },
  async run(ctx) {
    await refreshPending(ctx);
    const l = lockingOrders();
    if (!l.length) return { status: "UNLOCKED" };
    const o = l[0];
    return {
      status: "LOCKED",
      reason: o.status === "PENDING_CONFIRMATION" ? "DOUBLE_CONFIRM_PENDING" : "TX_PENDING",
      orderId: o.id,
      txHash: o.txHash,
      summary: o.summary,
      expiresAt: o.expiresAt ?? null,
    };
  },
});

define({
  name: "wallet.contacts",
  cli: "wallet contacts",
  title: "Address book (read-only)",
  description: "Saved recipients the agent may send to. Managed by the owner.",
  access: "session",
  write: false,
  params: {},
  async run() {
    return listContacts().map((c) => ({ name: c.name, address: c.address }));
  },
});

// Preflight helpers mirrored from `baw skill-check` / `baw cli-check`.
define({
  name: "skill-check",
  cli: "skill-check",
  title: "Skill version check",
  description: "Compare the installed skill version with the latest published one.",
  access: "public",
  write: false,
  params: { skillName: z.string().optional(), currentVersion: z.string().optional() },
  async run(ctx, { currentVersion }) {
    const url = process.env.SAW_SKILL_URL ?? `https://raw.githubusercontent.com/monkebo/solana-pay-mcp/main/skills/${SKILL_NAME}/SKILL.md`;
    try {
      const r = await ctx.fetch(url, { signal: AbortSignal.timeout(5000) });
      const text = await r.text();
      const latest = /version:\s*['"]?([0-9][^'"\s]*)/.exec(text)?.[1] ?? CLI_VERSION;
      return { needUpdateSkill: currentVersion ? cmp(latest, currentVersion) > 0 : false, latestSkillVersion: latest, checkedAt: nowMs() };
    } catch {
      return { needUpdateSkill: false, latestSkillVersion: null, checkedAt: nowMs() };
    }
  },
});

define({
  name: "cli-check",
  cli: "cli-check",
  title: "CLI version check",
  description: "Check the installed CLI meets the skill's required version.",
  access: "public",
  write: false,
  params: { requiredVersion: z.string().optional() },
  async run(_ctx, { requiredVersion }) {
    return { currentCliVersion: CLI_VERSION, needUpdateCli: requiredVersion ? cmp(requiredVersion, CLI_VERSION) > 0 : false };
  },
});

export function cmp(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}
