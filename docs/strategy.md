# Strategy: the layer above the wallets

*October 2026. The reasoning behind the 0.4 architecture, kept short so it can be argued with.*

## The uncertainty we cannot resolve

Every large player is shipping an agent wallet: Binance (Agentic Wallet, MPC custody, `baw` CLI, seven chains including Solana), Coinbase, OKX, Trust Wallet, OpenClawCash, plus self-custody keys. Nobody knows which becomes the default wallet for agents. Competing for that slot means competing with Binance's balance sheet for retail users, on a product that already supports Solana. We would lose.

## The move

Do not be a wallet. Be the layer every agent uses in front of whatever wallet wins.

One command surface, one policy, one approval flow, one ledger. Pluggable backends: our own key, Binance's `baw`, any HTTP signer, a human's wallet. The owner switches backends; agents and prompts never change.

It pays off in every branch we can name:

- Binance wins: we are the control plane in front of their wallet, with cross-wallet policy and a ledger they do not own.
- Binance loses or is blocked somewhere: the owner flips to self-custody; the agent keeps paying.
- Many wallets coexist (most likely): fragmentation makes a single layer above them more valuable, not less.
- One wallet wins everything: teams still need policy across agents and wallets, version-controlled, which vendors never build against their own lock-in.
- Agent commerce booms: every agent needs spending control. It stalls: the same layer is a safety tool for the agents that exist.
- Regulation tightens: we custody nothing and route to licensed custodians. It loosens: we route to self-custody.
- A platform adds a native payment rail: it becomes another backend.

No wallet vendor can take this position, because it requires treating competitors as equals. A small, neutral, open-source player can.

## Why mirror Binance's CLI

Their docs become our docs. Prompts written for `baw` run on `saw`. Their Skills Hub accepts any-chain skills, so we can list inside their funnel. And when a user needs to leave, the migration is an alias.

## Receiving

Payers are expensive to win; payees are a public key. Invoices with settlement proofs, a pay page any wallet can scan, x402 paywalls for agents that sell, and a ledger rebuildable from the chain. Every payer wallet, Binance's included, feeds it. Binance can process payments, but only between Binance accounts; permissionless, non-custodial, on-chain receiving for payees without accounts is outside their model.

## What we deliberately did not build

Trading, DeFi and prediction-market venues, and developer-mode external signing. 0.4 shipped them for Binance parity; 0.5 removed them. Parity theater earns nothing and costs trust. The product is payments under policy: send, batch, receive, approve, audit.

## The demo

Left: Claude running a payroll of five contractors. Right: the owner console. Payments one and two go out through Binance's agentic wallet. The owner flips the backend to self-custody; three to five go out from our key. The ledger shows all five under one policy. Then flip to a remote signer and send one more. "Binance just got restricted in your country. Your agents did not notice."

## Risks

Picks-and-shovels economics: revenue comes from teams, not retail. A framework vendor could ship a thin policy layer. Defences: the ledger, on-chain policy enforcement (Squads / smart-wallet programs) so even this control plane cannot exceed limits, and being first with the backend catalogue.
