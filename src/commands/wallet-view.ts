import { z } from "zod";
import { define, optNum, optStr } from "../core/registry.js";
import { walletAddress } from "../core/signer.js";
import { balances, gasLevels, txHistory } from "../core/view.js";
import { resolveToken } from "../core/tokens.js";
import { activeBackend } from "../core/backend.js";

define({
  name: "wallet.balance",
  cli: "wallet balance",
  title: "Token balances",
  description: "SOL and every token the wallet holds, with USD prices and values. Tokens worth less than $0.01 are hidden unless --includeDust.",
  access: "session",
  write: false,
  params: { symbol: optStr("Filter by symbol, e.g. USDC"), tokenAddress: optStr("Filter by mint address"), binanceChainId: optStr("Ignored; Solana only"), includeDust: z.preprocess((v) => v === "true" || v === true, z.boolean()).optional() },
  async run(ctx, { symbol, tokenAddress, includeDust }) {
    const be = activeBackend();
    let rows = be.balances ? await be.balances(ctx) : await balances(ctx, await walletAddress(), { includeDust });
    if (symbol) rows = rows.filter((r) => r.symbol.toUpperCase() === symbol.toUpperCase());
    if (tokenAddress) rows = rows.filter((r) => r.address === tokenAddress);
    return rows;
  },
});

define({
  name: "wallet.tx-history",
  cli: "wallet tx-history",
  title: "Transaction history",
  description: "Recent transactions of the wallet from the chain, plus pending ones this wallet broadcast. Cursor-paginated.",
  access: "session",
  write: false,
  params: {
    type: z.enum(["all", "pending", "confirmed"]).optional().describe("all (default) | pending | confirmed"),
    size: optNum("Page size, max 100"),
    nextCursor: optStr("Cursor from a previous page"),
    tx: optStr("Look up one transaction signature"),
    startTime: optNum("ms timestamp"),
    endTime: optNum("ms timestamp"),
    binanceChainId: optStr("Ignored; Solana only"),
  },
  async run(ctx, q) {
    return txHistory(ctx, await walletAddress(), q);
  },
});

define({
  name: "wallet.gas-price",
  cli: "wallet gas-price",
  title: "Priority fee levels",
  description: "LOW / MEDIUM / HIGH priority-fee tiers from recent blocks (micro-lamports per compute unit) and the tip in SOL they imply for a typical 200k-CU transaction. A snapshot, not a quote.",
  access: "session",
  write: false,
  params: { binanceChainId: optStr("Ignored; Solana only"), tokenAddress: optStr("Optional mint to scope fees to transactions touching it") },
  async run(ctx, { tokenAddress }) {
    const accounts = tokenAddress ? [(await resolveToken(ctx, tokenAddress)).mint] : [];
    return gasLevels(ctx, accounts.map((a) => a as never));
  },
});
