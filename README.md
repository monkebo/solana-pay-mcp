# solana-pay-mcp

**Stripe agent toolkit, but USDC on Solana.**

An MCP server that lets Claude (Claude Code, Claude Desktop, Cursor, any MCP client) invoice, get paid, and pay in USDC on Solana.

- "Invoice Acme 3000 USDC for October." → payment link + QR. Client pays from any wallet.
- "Did Acme pay?" → checks the chain, returns the transaction.
- "Pay Maria 400 USDC for the logo." → link + QR you approve in your own wallet.

The server never holds a private key. It builds [Solana Pay](https://docs.solanapay.com) links and reads the chain. Signing happens in your wallet (Phantom, Solflare, Backpack).

## Install

```bash
npm install -g solana-pay-mcp   # or run from source: npm i && npm run build
```

Add to Claude Code:

```bash
claude mcp add solana-pay -e SOLANA_PAY_RECIPIENT=<your wallet address> -e SOLANA_CLUSTER=devnet -- solana-pay-mcp
```

Or in `claude_desktop_config.json` / `.mcp.json`:

```json
{
  "mcpServers": {
    "solana-pay": {
      "command": "solana-pay-mcp",
      "env": { "SOLANA_PAY_RECIPIENT": "<your wallet address>", "SOLANA_CLUSTER": "devnet" }
    }
  }
}
```

## Tools

| Tool | What it does |
|---|---|
| `create_invoice(amount, memo)` | Invoice to `SOLANA_PAY_RECIPIENT`. Returns Solana Pay link, QR, id. |
| `send_payment(to, amount, memo)` | Pay someone. Returns a link/QR you open in your wallet. |
| `check_payment(id)` | Finds the on-chain USDC transfer for an invoice or payment. |
| `list_requests()` | Everything this server created, with paid status. |

> **Wallet reality check (tested 2026-10-10):** Phantom mobile parsed the Solana Pay link but could not load devnet balances; Solflare mobile rejected the link. Users will often pay by plain address instead. `check_payment` handles that: it first looks for the reference key, then falls back to scanning the recipient's USDC inflows after the request was created, and says which one matched.

Each request carries a fresh `reference` public key. Wallets attach it to the transaction, so `check_payment` finds it with one `getSignaturesForAddress` call and verifies recipient, mint and amount from the transaction's token balances. No webhooks, no indexer.

## Config

| Env | Default | Meaning |
|---|---|---|
| `SOLANA_PAY_RECIPIENT` | required | Wallet that receives invoices |
| `SOLANA_CLUSTER` | `devnet` | `devnet` or `mainnet` |
| `SOLANA_RPC_URL` | public RPC | Helius, Triton, etc. |
| `SOLANA_PAY_MCP_HOME` | `~/.solana-pay-mcp` | Where requests are stored (JSON) |

USDC mints: devnet `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`, mainnet `EPjFWdd5AufqSSqeM2qN1xqybapC8G4wEGGkZwyTDt1v`.

## Develop

```bash
npm i
npm test            # unit tests on URL building and paid-detection
npm run typecheck
SOLANA_PAY_RECIPIENT=<addr> node scripts/smoke.mjs   # drives the server over stdio against devnet
npm run inspect     # MCP Inspector
```

## Roadmap

- [ ] `monthly_report`: who paid, when, how much, categorized. CSV/PDF.
- [ ] `flag_anomalies`: unknown payer, duplicate invoice, amount mismatch.
- [ ] `create_recurring`: USDC subscriptions via [solana-foundation/subscriptions](https://github.com/solana-foundation/subscriptions).
- [ ] Hosted version with embedded wallets.
- [ ] 402 paywall on the report tools via [pay-kit](https://github.com/solana-foundation/pay-kit) and [pay.sh](https://pay.sh).

## Why

Stripe's agent toolkit gets ~90k installs a month because people want their agent to invoice and pay. Stripe takes 2.9% + 30¢ and needs a bank. USDC on Solana settles in ~200ms for a fraction of a cent and needs a wallet. Nobody had joined the two for MCP. Now it exists.

MIT.
