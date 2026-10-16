# solana-pay-mcp · `saw`

**A policy-controlled wallet for AI agents on Solana, that runs on whichever wallet you trust.**

Agents get one command surface (CLI, MCP tools, or an agent skill). The owner gets one policy, one approval queue and one ledger. Underneath, the money can sit in any of four places, and the agent never knows which:

| Backend | What holds the key | When to use it |
|---|---|---|
| `local` | a keypair on the vault host (self-custody) | default; no account, no KYC, runs anywhere |
| `baw` | [Binance Agentic Wallet](https://developers.binance.com/docs/agentic-wallet/welcome), via its `baw` CLI | you already use Binance |
| `signer` | any HTTP remote signer (Turnkey, Privy, Fireblocks, your HSM) | custody requirements |
| `solana-pay` | a human's own wallet (Phantom, Solflare, Backpack) | the agent prepares, the human scans and signs |

Switch with one owner command. Agents, prompts and skills do not change. Commands, flags and JSON mirror Binance's `baw`, so anything written for their wallet works here with one word changed.

It also **receives**: USDC invoices with a settlement proof and payer attribution, a pay page any wallet can scan, and x402 paywalls for agents that sell.

## Install

**Claude Code / Claude Desktop (MCP):**

```bash
npm install -g solana-pay-mcp
claude mcp add solana-pay -e SOLANA_CLUSTER=devnet -- solana-pay-mcp
```

**Claude Code, Codex, OpenClaw, Copilot (skill + CLI):**

```bash
npx skills add monkebo/solana-pay-mcp/skills/solana-agentic-wallet
```

**Any terminal or script:**

```bash
saw help
```

## Two minutes, local mode

```bash
saw owner keygen                                   # key on this machine; fund it with ~0.01 SOL + USDC
saw owner add-contact --name kevin --address <addr>
saw owner set-policy dailyLimitUsd=100 maxPaymentUsd=25
saw auth signin --json && saw auth verify --qrCodeId <id> --json   # self-approves in local mode
saw wallet balance --json
saw wallet send --amount 5 --recipient kevin --tokenAddress USDC --json
saw invoice create --amount 120 --memo "October retainer" --json
saw invoice status inv_xxxxxxxx --json
```

In Claude: "pay kevin 5 USDC for the logo", "invoice Acme 120 USDC for October", "did Acme pay?".

## Real money: vault mode

The vault holds the key and the policy. Agents hold only an expiring session token and must be paired by the owner.

```bash
saw vault serve --port 3000 --public-url https://wallet.example.com
# owner console at /, owner token in ~/.solana-pay-mcp/owner-token
```

On the agent side (another machine, a phone via claude.ai, a CI job):

```bash
SAW_VAULT_URL=https://wallet.example.com saw auth signin      # shows a 6-digit code
# owner approves it in the console (or `saw owner approve-pairing <code>` on the vault)
SAW_VAULT_URL=https://wallet.example.com saw auth verify --qrCodeId <id>
```

claude.ai custom connector: `https://wallet.example.com/mcp` with header `Authorization: Bearer <session token>`. `scripts/phone.sh` starts the vault behind a cloudflared tunnel.

Risky or large actions return `PENDING_CONFIRMATION`; the owner approves or rejects in the console within 5 minutes. The wallet is locked meanwhile.

## What agents can do

| Group | Commands |
|---|---|
| auth | `signin`, `verify`, `signout` |
| wallet | `status`, `whoami`, `chains`, `address`, `balance`, `tx-history`, `settings`, `tx-lock`, `gas-price`, `contacts`, `send`, `pay-many`, `speed-up`, `cancel` |
| invoice / ledger | `invoice create/status/list`, `ledger list/export/rebuild` |
| approvals | `list`, `detail`, `revoke` (SPL delegates) |
| x402-payment | `preview`, `sign`, `pay`, `list` |
| token | `search`, `audit` |

Every command takes `--json` and returns `{ success, data }` or `{ success: false, error: { code, name, message } }`. The full reference is generated from the code: [`skills/solana-agentic-wallet`](skills/solana-agentic-wallet/SKILL.md).

## What the owner controls

`saw owner fleet …`: create, fund, list, pause, resume, kill, set-policy, token, ledger (see Fleets above).


`saw owner policy` / `saw owner set-policy field=value …`

- `dailyLimitUsd`, `maxPaymentUsd`, and a separate daily limit for `x402`
- `addressBookOnly`: sends only to saved contacts
- `tradeAllTokens` / `allowedTokens`: which mints the agent may touch
- `abnormalTxnHandling`: `AutoReject` or `NeedConfirmation` for unknown recipients, unverified tokens, large amounts, authority changes
- `confirmAboveUsd`: anything above this waits for the owner
- `maxSigninDuration`, `inactiveSignoutDuration`, `requirePairingApproval`
- `backend`: `saw owner set-backend --kind local|baw|signer|solana-pay`

Defaults fail closed: $100/day, $50 per payment, contacts only, stables and SOL only, unknown tokens blocked, no USD price means no send.

## Fleets: a hundred agents, one policy, one kill switch

Binance gives one person one agent wallet, paired through its app. `saw` gives a developer as many as they want, from code, each with its own key and its own limits, under one owner.

```bash
saw owner fleet create --role translator --count 10 --dailyLimitUsd 1 --maxPaymentUsd 0.2   # 10 keys, 10 session tokens
saw owner fleet create --role buyer --count 5 --dailyLimitUsd 1.5 --maxPaymentUsd 0.3
saw owner fleet fund --amount 2 --sol 0.02          # treasury → every agent, 5 per transaction
saw owner fleet list --balances                     # leaderboard: USDC, SOL, spent today vs limit, status
saw owner fleet set-policy researcher dailyLimitUsd=0.5
saw owner fleet pause buyer-01 --reason "burning budget"   # AGENT_PAUSED on its next send
saw owner fleet pause all                           # FLEET_PAUSED for everyone; the treasury still works
saw owner fleet kill buyer-01                       # sessions revoked, key kept for the owner to sweep
saw owner fleet ledger                              # who paid whom, across every agent and the treasury
```

Each agent runs with its token as the session (`SAW_VAULT_URL=https://vault saw wallet send …`, or the MCP connector with `Authorization: Bearer <token>`). Agents are address-book entries by name, so `wallet send --recipient translator-03` just works. Quotas and the transaction lock are per agent: twenty agents pay in parallel without blocking each other.

The owner console shows the fleet as a live leaderboard with pause, resume and kill buttons, and a ledger of every payment. In Claude, `owner_fleet_list` renders the same as a card.

`scripts/fleet-sim.mjs` runs a market on devnet: buyers pay translators and researchers for jobs, one buyer overspends on purpose, the owner kills it from the console, the rest keep going.

## Receiving

`invoice create` returns a Solana Pay link, a QR and a pay page at `/pay/<id>` on the vault. The page serves a **transaction request**, so Phantom, Solflare and Backpack sign a transaction we authored, with the reference key and memo inside, and settlement matches exactly. Plain transfers that drop the reference are still matched by inflow and labelled `probable`. `ledger rebuild` re-derives every invoice from the chain, so the ledger is verifiable, not trusted.

## Config

| Env | Default | Meaning |
|---|---|---|
| `SOLANA_CLUSTER` | `devnet` | `devnet` or `mainnet` |
| `SOLANA_RPC_URL` | public RPC | Helius, Triton, etc. |
| `SAW_HOME` | `~/.solana-pay-mcp` | policy, sessions, orders, invoices, key |
| `SOLANA_PAY_SIGNER` | `$SAW_HOME/agent.json` | local key path |
| `SOLANA_PAY_RECIPIENT` | wallet address | where invoices are paid |
| `SAW_VAULT_URL` | unset | agent side: use a remote vault |
| `SAW_OWNER_TOKEN` | generated | vault owner token |
| `JUPITER_API_BASE`, `JUPITER_API_KEY` | lite-api.jup.ag | USD prices and token metadata for limits and risk checks |

## Develop

```bash
npm i
npm test              # mocked RPC and price API
npm run typecheck
npm run gen:skill     # regenerate skills/ from the command registry
SMOKE_HOME=$(mktemp -d) npm run smoke   # drive the MCP server over stdio
```

Why this shape, and why it is built to win regardless of which wallet wins: [docs/strategy.md](docs/strategy.md).

MIT.
