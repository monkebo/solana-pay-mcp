// Per-call context: who is calling (agent session or owner), plus injectable RPC and fetch for tests.
import { createSolanaRpc, type Rpc, type SolanaRpcApi } from "@solana/kit";
import { rpcUrl } from "./config.js";
import type { Session } from "./session.js";

export type Role = "agent" | "owner";

export interface Ctx {
  role: Role;
  /** Agent bearer token (session). */
  token?: string | null;
  session?: Session;
  rpc: Rpc<SolanaRpcApi>;
  fetch: typeof fetch;
  /** True while executing an action the owner just approved: skips the confirmation gate. */
  approved?: boolean;
  /** Public base URL of the vault (for pairing links). */
  vaultUrl?: string;
}

let cachedRpc: Rpc<SolanaRpcApi> | undefined;
let cachedFor: string | undefined;
export function defaultRpc(): Rpc<SolanaRpcApi> {
  const url = rpcUrl();
  if (!cachedRpc || cachedFor !== url) {
    cachedRpc = createSolanaRpc(url);
    cachedFor = url;
  }
  return cachedRpc;
}

export function createCtx(partial: Partial<Ctx> = {}): Ctx {
  return {
    role: "agent",
    token: null,
    fetch: globalThis.fetch.bind(globalThis),
    get rpc() {
      return partial.rpc ?? defaultRpc();
    },
    ...partial,
  } as Ctx;
}
