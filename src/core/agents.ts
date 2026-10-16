// Fleet: many agents, one owner. Each agent has its own key, its own policy overrides, its own quotas and lock,
// and shows up in one ledger. The owner creates, funds, pauses and kills agents; agents only hold a session token.
// The "current agent" travels with the call via AsyncLocalStorage, so policy, key and quota lookups need no plumbing.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { Collection } from "./store.js";
import { home } from "./config.js";
import { WalletError } from "./errors.js";
import { keygen } from "./keys.js";
import type { Policy } from "./policy.js";

/** Policy fields an agent may override. Everything else (backend, session durations, risk handling) stays global. */
export type AgentPolicy = Partial<Pick<Policy, "dailyLimitUsd" | "maxPaymentUsd" | "x402DailyLimitUsd" | "allowedTokens" | "tradeAllTokens" | "addressBookOnly" | "confirmAboveUsd">>;

export interface Agent {
  id: string; // agt_xxxx
  name: string; // unique, also the address-book name other agents pay to
  role: string; // free-form group label: translator, buyer, researcher
  address: string;
  keyPath: string;
  policy: AgentPolicy;
  status: "active" | "paused" | "killed";
  createdAt: number;
  pausedReason?: string;
}

export const agents = new Collection<Agent>("agents");

const scope = new AsyncLocalStorage<Agent | undefined>();

/** The agent a call runs as, or undefined for the owner / treasury wallet. */
export function currentAgent(): Agent | undefined {
  return scope.getStore();
}

export function runAsAgent<T>(agent: Agent | undefined, fn: () => T): T {
  return scope.run(agent, fn);
}

export function agentByName(name: string): Agent | undefined {
  const n = name.trim().toLowerCase();
  return agents.all().find((a) => a.name.toLowerCase() === n || a.id === name.trim());
}

export function requireAgent(idOrName: string): Agent {
  const a = agentByName(idOrName);
  if (!a) throw new WalletError("TARGET_NOT_FOUND", `No agent "${idOrName}". Run \`saw owner fleet list\`.`);
  return a;
}

export async function createAgent(input: { name: string; role: string; policy?: AgentPolicy }): Promise<Agent> {
  const name = input.name.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/i.test(name)) throw new WalletError("INVALID_PARAM", "Agent names: 1–32 chars, letters, digits, . _ -");
  if (agentByName(name)) throw new WalletError("INVALID_PARAM", `Agent "${name}" already exists.`);
  const id = `agt_${randomBytes(4).toString("hex")}`;
  const keyPath = join(home(), "agents", `${id}.json`);
  const address = await keygen(keyPath);
  return agents.put({ id, name, role: input.role.trim() || "agent", address, keyPath, policy: input.policy ?? {}, status: "active", createdAt: Date.now() });
}

export function setAgentStatus(a: Agent, status: Agent["status"], reason?: string): Agent {
  return agents.put({ ...a, status, pausedReason: status === "active" ? undefined : reason });
}

/** Owner-wide switch, stored next to the policy so it survives restarts. */
export const FLEET_PAUSE_KEY = "fleetPaused";

/** Throws when the current agent (or the whole fleet) may not act. Called by the gate before anything else. */
export function assertAgentActive(fleetPaused: boolean): void {
  const a = currentAgent();
  if (fleetPaused && a) throw new WalletError("FLEET_PAUSED", "The owner paused the whole fleet. Nothing is sent until `saw owner fleet resume all`.");
  if (!a) return;
  if (a.status === "killed") throw new WalletError("AGENT_PAUSED", `Agent ${a.name} was killed by the owner${a.pausedReason ? `: ${a.pausedReason}` : ""}. Its key no longer spends.`);
  if (a.status === "paused") throw new WalletError("AGENT_PAUSED", `Agent ${a.name} is paused by the owner${a.pausedReason ? `: ${a.pausedReason}` : ""}. Ask the owner to run \`saw owner fleet resume ${a.name}\`.`);
}
