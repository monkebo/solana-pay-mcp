// Agent-side client for a remote vault: POST /v1/exec with the session token. Same envelope as the CLI.
import { WalletError, CODES } from "./core/errors.js";

export async function remoteExec(vaultUrl: string, token: string | null, command: string, params: Record<string, unknown>): Promise<unknown> {
  const r = await fetch(`${vaultUrl.replace(/\/$/, "")}/v1/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ command, params }),
    signal: AbortSignal.timeout(Number(process.env.SAW_REMOTE_TIMEOUT_MS ?? 120_000)),
  });
  const text = await r.text();
  let body: { success: boolean; data?: unknown; error?: { code: number; name: string; message: string; data?: unknown } };
  try {
    body = JSON.parse(text);
  } catch {
    throw new WalletError("UPSTREAM_ERROR", `Vault returned ${r.status}: ${text.slice(0, 200)}`);
  }
  if (body.success) return body.data;
  const e = body.error ?? { code: 5001, name: "UPSTREAM_ERROR", message: "vault error" };
  const name = (Object.keys(CODES) as (keyof typeof CODES)[]).find((k) => CODES[k] === e.code) ?? "UPSTREAM_ERROR";
  throw new WalletError(name, e.message, e.data);
}
