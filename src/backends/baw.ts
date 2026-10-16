// Binance Agentic Wallet as a backend: every operation is executed by Binance's own `baw` CLI, under this
// control plane's policy, approvals and ledger. Because `saw` mirrors `baw`'s command surface, forwarding is
// mostly a flag-for-flag pass-through. If Binance is the right wallet for you today, nothing here stops you;
// if it stops being right tomorrow, the owner switches backend and the agent never notices.
import { execFile } from "node:child_process";
import { address } from "@solana/kit";
import { registerBackend, type Backend, type BackendConfig } from "../core/backend.js";
import { WalletError } from "../core/errors.js";
import { CHAIN_ID } from "../core/config.js";
import type { BalanceRow } from "../core/view.js";
import { SOL_MINT } from "../core/tokens.js";

/** Binance writes native SOL as this sentinel in its token tables. */
export const BAW_SOL = "So11111111111111111111111111111111111111111";

export type BawRunner = (args: string[]) => Promise<unknown>;

let runner: BawRunner | undefined;
/** Tests inject a fake runner; production shells out. */
export function setBawRunner(r: BawRunner | undefined): void {
  runner = r;
}

function makeRunner(bin: string): BawRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile(bin, [...args, "--json"], { timeout: Number(process.env.BAW_TIMEOUT_MS ?? 120_000), maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        const text = String(stdout || "").trim();
        let body: { success?: boolean; data?: unknown; error?: { code?: number; name?: string; message?: string } } | undefined;
        try {
          body = JSON.parse(text.slice(text.indexOf("{")));
        } catch {
          body = undefined;
        }
        if (body && body.success === false) {
          const e = body.error ?? {};
          return reject(new WalletError("UPSTREAM_ERROR", `baw ${args[0]} ${args[1] ?? ""}: ${e.message ?? "error"} (${e.name ?? "?"} ${e.code ?? ""})`.trim(), { baw: e }));
        }
        if (err && !body) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "ENOENT") return reject(new WalletError("UPSTREAM_UNAVAILABLE", `\`${bin}\` not found. Install Binance's CLI: npm install -g @binance/agentic-wallet`));
          return reject(new WalletError("UPSTREAM_ERROR", `baw failed: ${String(stderr || err.message).slice(0, 300)}`));
        }
        resolve(body?.data);
      });
    });
}

export function flags(params: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || k === "orderId" || k === "dryRun") continue;
    if (v === true) out.push(`--${k}`);
    else if (v === false) continue;
    else out.push(`--${k}`, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  return out;
}

registerBackend("baw", (cfg: BackendConfig): Backend => {
  const run = async (args: string[]) => {
    try {
      return await (runner ?? makeRunner(cfg.baw?.bin ?? "baw"))(args);
    } catch (e) {
      if (e instanceof WalletError) throw e;
      throw new WalletError("UPSTREAM_ERROR", `baw ${args.slice(0, 2).join(" ")}: ${(e as Error).message}`);
    }
  };
  let cached: ReturnType<typeof address> | undefined;

  async function addr() {
    if (cached) return cached;
    const r = (await run(["wallet", "address"])) as { addresses?: { binanceChainId: string; address: string }[] };
    const a = r?.addresses?.find((x) => x.binanceChainId === CHAIN_ID)?.address;
    if (!a) throw new WalletError("NO_WALLET", "Binance Agentic Wallet has no Solana address. Sign in with `baw auth signin` first.");
    cached = address(a);
    return cached;
  }

  return {
    kind: "baw",
    label: "Binance Agentic Wallet (via baw CLI)",
    canSign: false,
    address: addr,
    async signer() {
      throw new WalletError("NOT_SUPPORTED", "The Binance backend signs only through its own commands (send, x402). Switch to the local or signer backend for wallet-built transactions.");
    },
    async status() {
      try {
        const s = (await run(["wallet", "status"])) as { status?: string };
        return { connected: s?.status === "CONNECTED", detail: `baw status ${s?.status ?? "?"}` };
      } catch (e) {
        return { connected: false, detail: (e as Error).message };
      }
    },
    async balances() {
      const rows = (await run(["wallet", "balance", "--binanceChainId", CHAIN_ID])) as { symbol: string; address: string; balance: string; price?: string; value?: string }[];
      return (rows ?? []).map<BalanceRow>((r) => ({
        symbol: r.symbol,
        address: r.address === BAW_SOL ? SOL_MINT : r.address,
        binanceChainId: CHAIN_ID,
        balance: r.balance,
        decimals: -1,
        price: r.price ?? null,
        value: r.value ?? null,
        program: r.address === BAW_SOL ? "system" : "token",
      }));
    },
    async send(_ctx, p, params) {
      const r = (await run([
        "wallet", "send", "--amount", p.amount, "--recipient", p.to, "--binanceChainId", CHAIN_ID, "--tokenAddress", p.token.native ? BAW_SOL : p.token.mint,
        ...(params.gasLevel ? ["--gasLevel", params.gasLevel] : []),
      ])) as { txHash?: string };
      return { txHash: r?.txHash ?? null, status: "BROADCASTED", extra: { executedBy: "baw" } };
    },
    async x402Sign(_ctx, preview, option) {
      const pv = (await run(["x402-payment", "preview", "--paymentRequirements", JSON.stringify({ x402Version: preview.version, resource: preview.resource ?? undefined, accepts: preview.options.map((o) => o.originalAccept) })])) as {
        paymentId: string;
        options: { index: number; status: string; payTo?: string; originalAccept?: { payTo?: string; asset?: string; amount?: string } }[];
      };
      const acc = option.originalAccept;
      const match = pv.options.find((o) => (o.originalAccept?.payTo ?? o.payTo) === acc.payTo && o.originalAccept?.asset === acc.asset && (o.originalAccept?.amount === (acc.amount ?? acc.maxAmountRequired)));
      if (!match || match.status !== "READY_TO_SIGN") throw new WalletError("NOT_SUPPORTED", `Binance wallet cannot sign this option (${match?.status ?? "not offered"}).`);
      const s = (await run(["x402-payment", "sign", "--paymentId", pv.paymentId, "--selectedIndex", String(match.index)])) as { paymentHeaderName: string; paymentHeaderValue: string; signatureExpiresAt: number };
      return s;
    },
  };
});
