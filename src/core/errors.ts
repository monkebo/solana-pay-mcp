// One error shape for the CLI, the MCP tools and the vault HTTP API:
//   { success: false, error: { code, name, message, data? } }
// Codes are stable and documented in the skill; agents are told to relay `message` verbatim.

/** JSON.stringify that survives the BigInts kit's RPC returns (slots, lamports, instruction indexes). */
export function jsonSafe(v: unknown, space?: number): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), space);
}

/** Deep-convert BigInts to strings so a value can be stored or sent as JSON. */
export function plain<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(jsonSafe(v)) as T);
}

export class WalletError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(name: keyof typeof CODES, message: string, data?: unknown) {
    super(message);
    this.name = name;
    this.code = CODES[name];
    this.data = data;
  }
  toJSON() {
    return { code: this.code, name: this.name, message: this.message, ...(this.data !== undefined ? { data: plain(this.data) } : {}) };
  }
}

export const CODES = {
  // 1xxx: usage
  BAD_REQUEST: 1000,
  UNKNOWN_COMMAND: 1001,
  MISSING_PARAM: 1002,
  INVALID_PARAM: 1003,
  NOT_SUPPORTED: 1004,
  // 2xxx: auth / session
  NOT_SIGNED_IN: 2001,
  AUTH_REJECTED: 2002,
  AUTH_PENDING: 2003,
  SESSION_EXPIRED: 2004,
  OWNER_REQUIRED: 2005,
  NO_WALLET: 2006,
  // 3xxx: policy
  DAILY_LIMIT_EXCEEDED: 3001,
  PAYMENT_LIMIT_EXCEEDED: 3002,
  RECIPIENT_NOT_IN_ADDRESS_BOOK: 3003,
  TOKEN_NOT_ALLOWED: 3004,
  RISK_BLOCKED: 3005,
  DEV_MODE_DISABLED: 3006,
  PREDICTION_DISABLED: 3007,
  PRICE_UNAVAILABLE: 3008,
  LOCKED: 3009,
  CONFIRMATION_REQUIRED: 3010,
  AGENT_PAUSED: 3011,
  FLEET_PAUSED: 3012,
  // 4xxx: chain / execution
  INSUFFICIENT_BALANCE: 4001,
  SIMULATION_FAILED: 4002,
  BROADCAST_FAILED: 4003,
  TARGET_NOT_FOUND: 4004,
  ALREADY_CONFIRMED: 4005,
  TX_STATUS_UNSUPPORTED: 4006,
  PREVIEW_EXPIRED: 4007,
  UNSUPPORTED_ON_SOLANA: 4008,
  RPC_ERROR: 4009,
  // 5xxx: upstream services
  UPSTREAM_ERROR: 5001,
  UPSTREAM_UNAVAILABLE: 5002,
  SECURITY_CHECK_UNAVAILABLE: 5003,
  VENUE_UNAVAILABLE: 5004,
} as const;

export function toWalletError(e: unknown): WalletError {
  if (e instanceof WalletError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(msg)) return new WalletError("UPSTREAM_UNAVAILABLE", msg);
  if (/insufficient (funds|lamports)|0x1\b/i.test(msg)) return new WalletError("INSUFFICIENT_BALANCE", msg);
  return new WalletError("RPC_ERROR", msg);
}
