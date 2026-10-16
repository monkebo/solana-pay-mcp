// Fleet commands (owner only): many agents, one policy, one kill switch, one ledger.
//   saw owner fleet create --role translator --count 10 --dailyLimitUsd 1 --maxPaymentUsd 0.5
//   saw owner fleet fund --amount 2 --sol 0.02
//   saw owner fleet list | pause <name|all> | resume <name|all> | kill <name> | set-policy <target> k=v | ledger
import { z } from "zod";
import { address } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferCheckedInstruction } from "@solana-program/token";
import type { Instruction } from "@solana/kit";
import { define, num, optBool, optNum, optStr, str } from "../core/registry.js";
import { agents, createAgent, requireAgent, setAgentStatus, type Agent, type AgentPolicy } from "../core/agents.js";
import { issueSession, revokeAgentSessions, activeSessions } from "../core/session.js";
import { addContact, contacts, removeContact } from "../core/addressbook.js";
import { readOwnerPolicy, patchPolicy, readPolicy } from "../core/policy.js";
import { orders, newOrder, setOrder, quotaUsed } from "../core/orders.js";
import { runAsAgent } from "../core/agents.js";
import { activeBackend } from "../core/backend.js";
import { loadSigner } from "../core/signer.js";
import { resolveToken, fromUnits, toUnits } from "../core/tokens.js";
import { sendInstructions } from "../core/tx.js";
import { explorerUrl } from "../core/config.js";
import { WalletError } from "../core/errors.js";
import { usdValue } from "../core/prices.js";

const POLICY_KEYS: (keyof AgentPolicy)[] = ["dailyLimitUsd", "maxPaymentUsd", "x402DailyLimitUsd", "allowedTokens", "tradeAllTokens", "addressBookOnly", "confirmAboveUsd"];

function assertLocalBackend(): void {
  const be = activeBackend();
  if (be.kind !== "local") throw new WalletError("NOT_SUPPORTED", `Fleets need the local backend (one key per agent on this host); the active backend is "${be.kind}". Switch with \`saw owner set-backend --kind local\`.`);
}

function parseAssignments(assignments: string[]): AgentPolicy {
  const out: Record<string, unknown> = {};
  for (const a of assignments) {
    const i = a.indexOf("=");
    const k = a.slice(0, i) as keyof AgentPolicy;
    if (!POLICY_KEYS.includes(k)) throw new WalletError("INVALID_PARAM", `Agents can override only: ${POLICY_KEYS.join(", ")}.`);
    const raw = a.slice(i + 1);
    try {
      out[k] = JSON.parse(raw);
    } catch {
      out[k] = raw;
    }
  }
  return out as AgentPolicy;
}

function selectAgents(target: string): Agent[] {
  const t = target.trim().toLowerCase();
  const all = agents.all();
  if (t === "all") return all;
  const byRole = all.filter((a) => a.role.toLowerCase() === t);
  if (byRole.length) return byRole;
  return [requireAgent(target)];
}

/** Spend in the last 24h and the effective daily limit, as the agent itself would see them. */
function spendView(a: Agent) {
  return runAsAgent(a, () => {
    const p = readPolicy();
    const used = Math.round(quotaUsed("general") * 100) / 100;
    return { spentTodayUsd: used, dailyLimitUsd: p.dailyLimitUsd, leftUsd: Math.max(0, Math.round((p.dailyLimitUsd - used) * 100) / 100), maxPaymentUsd: p.maxPaymentUsd };
  });
}

function row(a: Agent) {
  return {
    id: a.id,
    name: a.name,
    role: a.role,
    address: a.address,
    status: a.status,
    pausedReason: a.pausedReason ?? null,
    sessions: activeSessions().filter((s) => s.agentId === a.id).length,
    policy: a.policy,
    ...spendView(a),
  };
}

define({
  name: "owner.fleet-create",
  cli: "owner fleet create",
  title: "Create fleet agents",
  description:
    "Create N agents, each with its own key, policy overrides and session token. Agents are added to the address book by name so they can pay each other. " +
    "Returns each agent's session token once: hand it to the agent process (SAW_VAULT_URL + `auth` is not needed; the token is the session).",
  access: "owner",
  write: true,
  params: {
    role: str("Group label, e.g. translator, buyer, researcher"),
    count: optNum("How many to create (default 1)"),
    name: optStr("Name for a single agent (default <role>-NN)"),
    dailyLimitUsd: optNum("Per-agent daily USD limit (default: owner policy)"),
    maxPaymentUsd: optNum("Per-agent max USD per payment (default: owner policy)"),
    addressBookOnly: optBool("Only pay saved contacts (default: owner policy)"),
  },
  async run(_ctx, { role, count, name, dailyLimitUsd, maxPaymentUsd, addressBookOnly }) {
    assertLocalBackend();
    const n = Math.max(1, Math.min(200, Math.floor(count ?? 1)));
    if (name && n > 1) throw new WalletError("INVALID_PARAM", "--name is for a single agent; use --role with --count for many.");
    const policy: AgentPolicy = {};
    if (dailyLimitUsd !== undefined) policy.dailyLimitUsd = dailyLimitUsd;
    if (maxPaymentUsd !== undefined) policy.maxPaymentUsd = maxPaymentUsd;
    if (addressBookOnly !== undefined) policy.addressBookOnly = addressBookOnly;
    const existing = agents.all().filter((a) => a.role === role).length;
    const made: Record<string, unknown>[] = [];
    for (let i = 0; i < n; i++) {
      const nm = name ?? `${role}-${String(existing + i + 1).padStart(2, "0")}`;
      const a = await createAgent({ name: nm, role, policy });
      addContact(a.name, a.address);
      made.push({ id: a.id, name: a.name, role: a.role, address: a.address, token: issueSession(a.id, `fleet ${a.name}`) });
    }
    return { created: made.length, agents: made, next: "Fund them with `saw owner fleet fund --amount <usdc> --sol 0.02`. Tokens are shown once." };
  },
});

define({
  name: "owner.fleet-list",
  cli: "owner fleet list",
  title: "List fleet agents",
  description: "Every agent with status, spend today against its limit, sessions, and (with --balances) on-chain SOL and USDC.",
  access: "owner",
  write: false,
  params: { role: optStr("Filter by role"), balances: optBool("Also read on-chain balances (one RPC round per agent)") },
  async run(ctx, { role, balances }) {
    const list = agents.all().filter((a) => !role || a.role === role).sort((a, b) => a.name.localeCompare(b.name));
    const rows = list.map(row) as (ReturnType<typeof row> & { usdc?: string; sol?: string })[];
    let balanceError: string | null = null;
    if (balances && rows.length) {
      // Two RPC calls per 100 agents (getMultipleAccounts on the USDC token accounts, then on the owners),
      // instead of two per agent: public RPCs rate-limit a fleet read in one burst. Unknown stays undefined, never 0.
      try {
        const usdc = await resolveToken(ctx, "USDC");
        const mint = address(usdc.mint);
        const atas = await Promise.all(rows.map(async (r) => (await findAssociatedTokenPda({ mint, owner: address(r.address), tokenProgram: usdc.programAddress }))[0]));
        for (let i = 0; i < rows.length; i += 100) {
          const chunk = rows.slice(i, i + 100);
          const tok = await ctx.rpc.getMultipleAccounts(atas.slice(i, i + 100), { encoding: "jsonParsed" }).send();
          const sol = await ctx.rpc.getMultipleAccounts(chunk.map((r) => address(r.address))).send();
          chunk.forEach((r, j) => {
            const acc = tok.value[j] as { data?: { parsed?: { info?: { tokenAmount?: { amount: string } } } } } | null;
            r.usdc = fromUnits(BigInt(acc?.data?.parsed?.info?.tokenAmount?.amount ?? "0"), usdc.decimals);
            r.sol = fromUnits(BigInt(sol.value[j]?.lamports ?? 0n), 9);
          });
        }
      } catch (e) {
        balanceError = (e as Error).message.slice(0, 200);
      }
    }
    const p = readOwnerPolicy();
    return { fleetPaused: p.fleetPaused, total: rows.length, active: rows.filter((r) => r.status === "active").length, spentTodayUsd: Math.round(rows.reduce((s, r) => s + r.spentTodayUsd, 0) * 100) / 100, balanceError, agents: rows };
  },
});

define({
  name: "owner.fleet-fund",
  cli: "owner fleet fund",
  title: "Fund fleet agents from the treasury",
  description: "Send USDC (and a little SOL for fees) from the owner's treasury key to every active agent, 5 agents per transaction.",
  access: "owner",
  write: true,
  params: { amount: num("USDC per agent"), sol: optNum("SOL per agent for fees (default 0.01)"), role: optStr("Only agents with this role"), name: optStr("Only this agent") },
  async run(ctx, { amount, sol, role, name }) {
    assertLocalBackend();
    const targets = agents.all().filter((a) => a.status !== "killed" && (!role || a.role === role) && (!name || a.name === name)).sort((a, b) => a.name.localeCompare(b.name));
    if (!targets.length) throw new WalletError("TARGET_NOT_FOUND", "No matching agents to fund.");
    const treasury = await loadSigner();
    const usdc = await resolveToken(ctx, "USDC");
    const mint = address(usdc.mint);
    const [from] = await findAssociatedTokenPda({ mint, owner: treasury.address, tokenProgram: usdc.programAddress });
    const units = toUnits(String(amount), usdc.decimals);
    const lamports = BigInt(Math.round((sol ?? 0.01) * 1e9));
    const txs: { agents: string[]; txHash: string; explorer: string }[] = [];
    for (let i = 0; i < targets.length; i += 5) {
      const batch = targets.slice(i, i + 5);
      const ixs: Instruction[] = [];
      for (const a of batch) {
        const to = address(a.address);
        if (lamports > 0n) ixs.push(getTransferSolInstruction({ source: treasury, destination: to, amount: lamports }));
        if (units > 0n) {
          const [ata] = await findAssociatedTokenPda({ mint, owner: to, tokenProgram: usdc.programAddress });
          ixs.push(getCreateAssociatedTokenIdempotentInstruction({ payer: treasury, owner: to, mint, ata, tokenProgram: usdc.programAddress }));
          ixs.push(getTransferCheckedInstruction({ source: from, mint, destination: ata, authority: treasury, amount: units, decimals: usdc.decimals }, { programAddress: usdc.programAddress }));
        }
      }
      const summary = `fund ${batch.map((a) => a.name).join(", ")}: ${amount} USDC + ${sol ?? 0.01} SOL each`;
      const { usd } = await usdValue(ctx, usdc.mint, String(amount * batch.length), "USDC").catch(() => ({ usd: amount * batch.length }));
      const o = newOrder({ kind: "send", category: "general", status: "BROADCASTED", usdValue: usd, summary, details: { fleetFund: batch.map((a) => a.name) }, backend: "local", reasons: [] });
      try {
        const b = await sendInstructions(ctx, ixs);
        setOrder(o.id, { txHash: b.signature, signedTx: b.signedTx, lastValidBlockHeight: b.lastValidBlockHeight });
        txs.push({ agents: batch.map((a) => a.name), txHash: b.signature, explorer: explorerUrl(b.signature) });
      } catch (e) {
        setOrder(o.id, { status: "FAILED", error: (e as Error).message });
        throw e;
      }
    }
    return { funded: targets.length, perAgent: { usdc: String(amount), sol: String(sol ?? 0.01) }, transactions: txs };
  },
});

const target = { target: str("Agent name, agent id, a role, or `all`") };

define({
  name: "owner.fleet-pause",
  cli: "owner fleet pause",
  title: "Pause agents",
  description: "Stop one agent, a whole role, or the entire fleet from spending. Sessions stay valid; every write is refused with AGENT_PAUSED / FLEET_PAUSED.",
  access: "owner",
  write: true,
  positional: ["target"],
  params: { ...target, reason: optStr("Shown to the agent in the error") },
  async run(_ctx, { target: t, reason }) {
    if (t.trim().toLowerCase() === "all") {
      patchPolicy({ fleetPaused: true });
      return { fleetPaused: true, agents: agents.all().length };
    }
    const hit = selectAgents(t).map((a) => setAgentStatus(a, "paused", reason));
    return { paused: hit.map((a) => a.name) };
  },
});

define({
  name: "owner.fleet-resume",
  cli: "owner fleet resume",
  title: "Resume agents",
  description: "Let paused agents (or the whole fleet) spend again. Killed agents stay killed.",
  access: "owner",
  write: true,
  positional: ["target"],
  params: target,
  async run(_ctx, { target: t }) {
    if (t.trim().toLowerCase() === "all") {
      patchPolicy({ fleetPaused: false });
      return { fleetPaused: false };
    }
    const hit = selectAgents(t).filter((a) => a.status === "paused").map((a) => setAgentStatus(a, "active"));
    return { resumed: hit.map((a) => a.name) };
  },
});

define({
  name: "owner.fleet-kill",
  cli: "owner fleet kill",
  title: "Kill an agent",
  description: "Permanent: revokes the agent's sessions and refuses every future action. The key file stays so the owner can sweep remaining funds.",
  access: "owner",
  write: true,
  positional: ["target"],
  params: { ...target, reason: optStr("Why") },
  async run(_ctx, { target: t, reason }) {
    const hit = selectAgents(t);
    const out = hit.map((a) => ({ name: a.name, sessionsRevoked: revokeAgentSessions(a.id), status: setAgentStatus(a, "killed", reason).status }));
    return { killed: out };
  },
});

define({
  name: "owner.fleet-set-policy",
  cli: "owner fleet set-policy",
  title: "Change agent policy overrides",
  description: "Override policy for one agent, a role, or all: `saw owner fleet set-policy translator dailyLimitUsd=0.5 maxPaymentUsd=0.1`. Allowed: " + POLICY_KEYS.join(", ") + ".",
  access: "owner",
  write: true,
  positional: ["target", "assignments[]"],
  params: { ...target, assignments: z.preprocess((v) => (typeof v === "string" ? [v] : v), z.array(z.string().regex(/^[A-Za-z0-9_.]+=.+$/, "field=value"))).describe("field=value pairs") },
  async run(_ctx, { target: t, assignments }) {
    const patch = parseAssignments(assignments);
    const hit = selectAgents(t).map((a) => agents.put({ ...a, policy: { ...a.policy, ...patch } }));
    return { updated: hit.map((a) => a.name), policy: patch };
  },
});

define({
  name: "owner.fleet-rename",
  cli: "owner fleet rename",
  title: "Rename an agent",
  description: "Give an agent a new name and/or role. Keys, balances, sessions and history stay; the address-book entry follows the name.",
  access: "owner",
  write: true,
  positional: ["target"],
  params: { target: str("Current agent name or id"), name: optStr("New name"), role: optStr("New role") },
  async run(_ctx, { target: t, name, role }) {
    const a = requireAgent(t);
    if (name && name !== a.name) {
      if (!/^[a-z0-9][a-z0-9._-]{0,31}$/i.test(name)) throw new WalletError("INVALID_PARAM", "Agent names: 1–32 chars, letters, digits, . _ -");
      if (agents.all().some((x) => x.id !== a.id && x.name.toLowerCase() === name.toLowerCase())) throw new WalletError("INVALID_PARAM", `Agent "${name}" already exists.`);
      try { removeContact(a.name); } catch { /* not in the book */ }
      addContact(name, a.address);
    }
    const next = agents.put({ ...a, name: name ?? a.name, role: role ?? a.role });
    return { id: next.id, name: next.name, role: next.role, address: next.address };
  },
});

define({
  name: "owner.fleet-token",
  cli: "owner fleet token",
  title: "Reissue an agent's session token",
  description: "Revoke the agent's current sessions and issue a fresh token (shown once).",
  access: "owner",
  write: true,
  positional: ["target"],
  params: { target: str("Agent name or id") },
  async run(_ctx, { target: t }) {
    const a = requireAgent(t);
    if (a.status === "killed") throw new WalletError("AGENT_PAUSED", `Agent ${a.name} is killed.`);
    revokeAgentSessions(a.id);
    return { name: a.name, token: issueSession(a.id, `fleet ${a.name}`) };
  },
});

define({
  name: "owner.fleet-ledger",
  cli: "owner fleet ledger",
  title: "Fleet ledger",
  description: "Latest orders across every agent and the treasury: who paid whom, how much, status, transaction.",
  access: "owner",
  write: false,
  params: { limit: optNum("Rows (default 50, max 500)"), agent: optStr("Only this agent name") },
  async run(_ctx, { limit, agent }) {
    const byId = new Map(agents.all().map((a) => [a.id, a]));
    const byAddr = new Map<string, string>([...agents.all().map((a) => [a.address, a.name] as const), ...contacts.all().map((c) => [c.address, c.name] as const)]);
    const n = Math.min(500, Math.max(1, limit ?? 50));
    const rows = orders
      .all()
      .filter((o) => !agent || byId.get(o.agentId ?? "")?.name === agent)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, n)
      .map((o) => {
        const d = o.details as { recipient?: string; recipientLabel?: string | null; amount?: string; token?: string; memo?: string | null; fleetFund?: string[] };
        return {
          id: o.id,
          at: new Date(o.createdAt).toISOString(),
          agent: o.agentId ? (byId.get(o.agentId)?.name ?? o.agentId) : "treasury",
          to: d.fleetFund ? d.fleetFund.join(", ") : (d.recipientLabel ?? (d.recipient ? byAddr.get(d.recipient) ?? d.recipient : null)),
          amount: d.amount ?? null,
          token: d.token ?? null,
          usd: o.usdValue,
          memo: d.memo ?? null,
          status: o.status,
          error: o.error ?? null,
          txHash: o.txHash,
          explorer: o.txHash ? explorerUrl(o.txHash) : null,
        };
      });
    return { rows };
  },
});
