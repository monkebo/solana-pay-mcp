// Command groups with no native Solana implementation yet. On the Binance backend they forward to `baw`
// (under this control plane's policy gate); on other backends they explain what is missing instead of pretending.
import { define, type Command } from "../core/registry.js";
import { activeBackend } from "../core/backend.js";
import { WalletError } from "../core/errors.js";
import type { Category } from "../core/orders.js";

const groups: { cli: string; title: string; write: boolean; category: Category }[] = [
  { cli: "defi protocol-list", title: "List DeFi protocols (TVL / APY)", write: false, category: "defi" },
  { cli: "defi protocol-info", title: "DeFi protocol details", write: false, category: "defi" },
  { cli: "defi investment-list", title: "List DeFi investments (Earn / LiquidityPool)", write: false, category: "defi" },
  { cli: "defi investment-info", title: "DeFi investment details", write: false, category: "defi" },
  { cli: "defi position", title: "My DeFi positions", write: false, category: "defi" },
  { cli: "defi preview", title: "Preview a DeFi transaction", write: false, category: "defi" },
  { cli: "defi deposit", title: "Deposit / stake / supply", write: true, category: "defi" },
  { cli: "defi redeem", title: "Redeem / unstake / withdraw", write: true, category: "defi" },
  { cli: "defi lp-add", title: "Add liquidity", write: true, category: "defi" },
  { cli: "defi lp-remove", title: "Remove liquidity", write: true, category: "defi" },
  { cli: "defi claim", title: "Claim rewards / matured redemptions", write: true, category: "defi" },
  { cli: "prediction category list", title: "Prediction market categories", write: false, category: "prediction" },
  { cli: "prediction market list", title: "List prediction markets", write: false, category: "prediction" },
  { cli: "prediction market detail", title: "Prediction market details", write: false, category: "prediction" },
  { cli: "prediction market search", title: "Search prediction markets", write: false, category: "prediction" },
  { cli: "prediction market order-book", title: "Prediction order book", write: false, category: "prediction" },
  { cli: "prediction market last-trade-price", title: "Last trade price", write: false, category: "prediction" },
  { cli: "prediction position list", title: "My prediction positions", write: false, category: "prediction" },
  { cli: "prediction position token", title: "Position by token id", write: false, category: "prediction" },
  { cli: "prediction position settled-history", title: "Settled prediction history", write: false, category: "prediction" },
  { cli: "prediction position pnl", title: "Prediction PnL records", write: false, category: "prediction" },
  { cli: "prediction position portfolio", title: "Prediction portfolio summary", write: false, category: "prediction" },
  { cli: "prediction order history", title: "Prediction order history", write: false, category: "prediction" },
  { cli: "prediction trade quote", title: "Prediction trade quote", write: false, category: "prediction" },
  { cli: "prediction trade place-order", title: "Place a prediction order", write: true, category: "prediction" },
  { cli: "prediction trade cancel", title: "Cancel a prediction order", write: true, category: "prediction" },
  { cli: "prediction trade redeem", title: "Redeem winning positions", write: true, category: "prediction" },
];

for (const g of groups) {
  define({
    name: g.cli.replace(/ /g, "."),
    cli: g.cli,
    title: g.title,
    description: `${g.title}. Available when the backend is Binance Agentic Wallet (forwarded to \`baw ${g.cli}\` with the same flags, under this wallet's ${g.category} daily limit). No native Solana venue is wired yet for other backends.`,
    access: "session",
    write: g.write,
    category: g.category,
    loose: true,
    forwardable: true,
    params: {},
    async run() {
      const be = activeBackend();
      throw new WalletError("VENUE_UNAVAILABLE", `\`${g.cli}\` has no native Solana provider in this build; it is available on the Binance backend (owner: \`saw owner set-backend --kind baw\`). Active backend: ${be.kind}.`);
    },
  } as Command<Record<string, never>>);
}
