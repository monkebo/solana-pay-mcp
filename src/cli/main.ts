// `saw` entry. Local mode runs commands in-process; with SAW_VAULT_URL set they are proxied to the vault.
import "../commands/index.js";
import { parseArgv } from "./args.js";
import { human } from "./format.js";
import { commands, exec, matchCli, type Command } from "../core/registry.js";
import { createCtx } from "../core/ctx.js";
import { toWalletError, WalletError, jsonSafe } from "../core/errors.js";
import { localSession } from "../core/session.js";
import { CLI_VERSION } from "../core/config.js";

export function buildParams(cmd: Command, positional: string[], flags: Record<string, string | boolean>): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...flags };
  const names = cmd.positional ?? [];
  positional.forEach((v, i) => {
    const n = names[i] ?? names[names.length - 1];
    if (!n) return;
    if (n.endsWith("[]")) {
      const k = n.slice(0, -2);
      (raw[k] as string[] | undefined) ? (raw[k] as string[]).push(v) : (raw[k] = [v]);
    } else if (raw[n] === undefined) raw[n] = v;
  });
  return raw;
}

function helpText(): string {
  const groups = new Map<string, Command[]>();
  for (const c of commands()) {
    const g = c.cli.split(" ")[0];
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  const lines = [`saw ${CLI_VERSION}: Solana agentic wallet CLI. Append --json for machine output.`, ""];
  for (const [g, cs] of groups) {
    lines.push(g);
    for (const c of cs) lines.push(`  ${c.cli.padEnd(30)} ${c.title}${c.access === "owner" ? "  [owner]" : ""}`);
  }
  return lines.join("\n");
}

export async function runCli(argv: string[]): Promise<number> {
  const parsed = parseArgv(argv);
  const out = (v: unknown) => process.stdout.write((parsed.json ? jsonSafe(v) : human(v)) + "\n");
  if (!parsed.words.length || parsed.words[0] === "help" || parsed.flags.help) {
    process.stdout.write(helpText() + "\n");
    return 0;
  }
  if (parsed.words[0] === "version") {
    out(parsed.json ? { success: true, data: { version: CLI_VERSION } } : { version: CLI_VERSION });
    return 0;
  }
  const m = matchCli(parsed.words);
  if (!m) {
    out({ success: false, error: new WalletError("UNKNOWN_COMMAND", `Unknown command "${parsed.words.join(" ")}". Run \`saw help\`.`).toJSON() });
    return 1;
  }
  const raw = buildParams(m.cmd, [...m.rest, ...parsed.positional], parsed.flags);
  const saved = localSession.read();
  const vaultUrl = process.env.SAW_VAULT_URL ?? saved.vaultUrl ?? undefined;
  const ctx = createCtx({ role: m.cmd.cli.startsWith("owner") ? "owner" : "agent", token: saved.token, vaultUrl });
  try {
    let data: unknown;
    if (vaultUrl && !m.cmd.cli.startsWith("owner")) {
      const { remoteExec } = await import("../remote.js");
      data = await remoteExec(vaultUrl, saved.token, m.cmd.name, raw);
    } else {
      data = await exec(ctx, m.cmd.name, raw);
    }
    // Client-side bookkeeping for sessions.
    if (m.cmd.name === "auth.verify" && data && typeof data === "object" && "token" in data) {
      const { token, ...rest } = data as { token: string };
      localSession.write({ token, vaultUrl: vaultUrl ?? null });
      data = rest;
    }
    if (m.cmd.name === "auth.signout") localSession.clear();
    out(parsed.json ? { success: true, data } : data);
    return 0;
  } catch (e) {
    const err = toWalletError(e);
    out(parsed.json ? { success: false, error: err.toJSON() } : { error: `${err.name} (${err.code})`, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) });
    return 1;
  }
}
