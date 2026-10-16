// Command registry. Every capability is defined once here and surfaced three ways:
// the `saw` CLI, the MCP tools, and the vault HTTP API. The skill docs are generated from it too.
import { z } from "zod";
import { WalletError } from "./errors.js";
import { authenticate } from "./session.js";
import type { Ctx } from "./ctx.js";
import type { Category } from "./orders.js";

export type Access = "public" | "session" | "owner";

export interface Command<S extends z.ZodRawShape = z.ZodRawShape> {
  /** Dotted id, e.g. `wallet.send`. */
  name: string;
  /** CLI words, e.g. `wallet send`. */
  cli: string;
  title: string;
  description: string;
  access: Access;
  /** State-changing: the skill tells the agent to confirm with the user first. */
  write: boolean;
  /** Names of params that may be given positionally on the CLI, in order. */
  positional?: string[];
  /** Quota category for writes (default general). */
  category?: Category;
  /** Accept unknown params (pass-through commands). */
  loose?: boolean;
  params: S;
  run: (ctx: Ctx, args: z.infer<z.ZodObject<S>>) => Promise<unknown>;
}

const registry = new Map<string, Command>();

export function define<S extends z.ZodRawShape>(c: Command<S>): Command<S> {
  if (registry.has(c.name)) throw new Error(`duplicate command ${c.name}`);
  registry.set(c.name, c as unknown as Command);
  return c;
}

export function commands(): Command[] {
  return [...registry.values()];
}

export function get(name: string): Command | undefined {
  return registry.get(name);
}

/** Longest CLI-word prefix match: ["wallet","send","--amount"] → wallet.send + rest. */
export function matchCli(words: string[]): { cmd: Command; rest: string[] } | undefined {
  for (let n = Math.min(words.length, 4); n > 0; n--) {
    const key = words.slice(0, n).join(" ");
    const cmd = commands().find((c) => c.cli === key);
    if (cmd) return { cmd, rest: words.slice(n) };
  }
  return undefined;
}

export async function exec(ctx: Ctx, name: string, raw: Record<string, unknown>): Promise<unknown> {
  const cmd = registry.get(name);
  if (!cmd) throw new WalletError("UNKNOWN_COMMAND", `Unknown command ${name}. Run \`saw help\`.`);
  if (cmd.access === "owner" && ctx.role !== "owner") {
    throw new WalletError("OWNER_REQUIRED", `${cmd.cli} is an owner command. Settings and approvals change only on the owner side, never from the agent.`);
  }
  if (cmd.access === "session" && ctx.role !== "owner") {
    ctx.session = authenticate(ctx.token);
  }
  let args: Record<string, unknown>;
  try {
    const schema = z.object(cmd.params);
    args = (cmd.loose ? schema.passthrough() : schema).parse(raw);
  } catch (e) {
    if (e instanceof z.ZodError) {
      const issues = e.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      throw new WalletError("INVALID_PARAM", `Invalid parameters for ${cmd.cli}: ${issues}`);
    }
    throw e;
  }
  return cmd.run(ctx, args as never);
}

// Param helpers: CLI flags arrive as strings, MCP args as typed JSON. These accept both.
export const bool = (desc: string) =>
  z.preprocess((v) => (v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : v), z.boolean()).describe(desc);
export const optBool = (desc: string) => bool(desc).optional();
export const num = (desc: string) => z.coerce.number().describe(desc);
export const optNum = (desc: string) => z.coerce.number().optional().describe(desc);
export const str = (desc: string) => z.string().min(1).describe(desc);
export const optStr = (desc: string) => z.string().optional().describe(desc);
/** Decimal amount as a string, validated as positive. */
export const amount = (desc: string) =>
  z.preprocess((v) => (typeof v === "number" ? String(v) : v), z.string().regex(/^\d+(\.\d+)?$/, "decimal amount, e.g. 1.5")).describe(desc);
