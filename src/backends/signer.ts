// Generic HTTP remote signer. Two endpoints, so any custodian can be adapted in a few lines:
//   GET  {url}/address                      → { "address": "<base58>" }
//   POST {url}/sign { "message": "<base64>" } → { "signature": "<base64 64 bytes>" }
// Authorization: Bearer <token>. The signer never sees policy; this control plane applies it first.
import { address, getBase64Decoder, getBase64Encoder, type Address, type SignatureBytes, type TransactionPartialSigner } from "@solana/kit";
import { registerBackend, type Backend, type BackendConfig } from "../core/backend.js";
import { WalletError } from "../core/errors.js";

registerBackend("signer", (cfg: BackendConfig): Backend => {
  const c = cfg.signer;
  if (!c?.url) throw new WalletError("INVALID_PARAM", "backend.signer.url is required for the signer backend.");
  const base = c.url.replace(/\/$/, "");
  const headers = { "content-type": "application/json", ...(c.token ? { authorization: `Bearer ${c.token}` } : {}) };
  let cached: Address | undefined = c.address ? address(c.address) : undefined;

  async function call<T>(path: string, body?: unknown): Promise<T> {
    let r: Response;
    try {
      r = await fetch(base + path, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
    } catch (e) {
      throw new WalletError("UPSTREAM_UNAVAILABLE", `Remote signer unreachable: ${(e as Error).message}`);
    }
    if (!r.ok) throw new WalletError("UPSTREAM_ERROR", `Remote signer ${path} returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return (await r.json()) as T;
  }

  async function addr(): Promise<Address> {
    if (!cached) cached = address((await call<{ address: string }>("/address")).address);
    return cached;
  }

  const signer: TransactionPartialSigner & { address: Address } = {
    get address() {
      if (!cached) throw new WalletError("UPSTREAM_ERROR", "Remote signer address not loaded yet; call address() first.");
      return cached;
    },
    async signTransactions(transactions) {
      const me = await addr();
      const enc = getBase64Decoder();
      const dec = getBase64Encoder();
      const out = [];
      for (const tx of transactions) {
        const r = await call<{ signature: string }>("/sign", { message: enc.decode(tx.messageBytes), address: me });
        const bytes = new Uint8Array(dec.encode(r.signature));
        if (bytes.length !== 64) throw new WalletError("UPSTREAM_ERROR", "Remote signer returned a signature that is not 64 bytes.");
        out.push({ [me]: bytes as SignatureBytes });
      }
      return out;
    },
  };

  return {
    kind: "signer",
    label: `Remote signer at ${base}`,
    canSign: true,
    address: addr,
    async signer() {
      await addr();
      return signer;
    },
    async status() {
      try {
        return { connected: true, detail: `address ${await addr()}` };
      } catch (e) {
        return { connected: false, detail: (e as Error).message };
      }
    },
  };
});
