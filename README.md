# solana-pay-mcp · `saw`

**A policy-controlled wallet for AI agents on Solana, that runs on whichever wallet you trust.**

Agents get one command surface (CLI, MCP tools, or an agent skill). The owner gets one policy, one approval queue and one ledger. Underneath, the money can sit in any of four places, and the agent never knows which:

| Backend | What holds the key | When to use it |
|---|---|---|
| `local` | a keypair on the vault host (self-custody) | default; no account, no KYC, runs anywhere |
| `baw` | [Binance Agentic Wallet](https://developers.binance.com/docs/agentic-wallet/welcome), via its `baw` CLI | you already use Binance; get DeFi and prediction markets too |
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
| wallet | `status`, `chains`, `address`, `balance`, `tx-history`, `settings`, `tx-lock`, `gas-price`, `contacts`, `send`, `pay-many`, `speed-up`, `cancel` |
| invoice / ledger | `invoice create/status/list`, `ledger list/export/rebuild` |
| market-order | `quote`, `swap`, `list` (Jupiter) |
| limit-order | `buy`, `sell`, `list`, `cancel` (Jupiter trigger orders) |
| approvals | `list`, `detail`, `revoke` (SPL delegates) |
| contract-call / sign-message | `preview`, `execute`, `result`, `history` (Developer Mode) |
| x402-payment | `preview`, `sign`, `pay`, `list` |
| token | `search`, `audit` |
| defi, prediction | forwarded to Binance when the backend is `baw` |

Every command takes `--json` and returns `{ success, data }` or `{ success: false, error: { code, name, message } }`. The full reference is generated from the code: [`skills/solana-agentic-wallet`](skills/solana-agentic-wallet/SKILL.md).

## What the owner controls

`saw owner policy` / `saw owner set-policy field=value …`

- `dailyLimitUsd`, `maxPaymentUsd`, and separate daily limits for `x402`, `defi`, `prediction` and Developer Mode
- `addressBookOnly`: sends only to saved contacts
- `tradeAllTokens` / `allowedTokens`: which mints the agent may touch
- `abnormalTxnHandling`: `AutoReject` or `NeedConfirmation` for unknown recipients, unverified tokens, large amounts, authority changes
- `confirmAboveUsd`: anything above this waits for the owner
- `maxSigninDuration`, `inactiveSignoutDuration`, `requirePairingApproval`
- `devMode`: time-boxed external signing with its own limit (`saw owner dev-mode --enabled true --hours 24 --dailyLimitUsd 50`)
- `backend`: `saw owner set-backend --kind local|baw|signer|solana-pay`

Defaults fail closed: $100/day, $50 per payment, contacts only, stables and SOL only, unknown tokens blocked, no USD price means no send.

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
| `JUPITER_API_BASE`, `JUPITER_API_KEY` | lite-api.jup.ag | swaps, prices, token data |
| `JITO_TIP_LAMPORTS` | unset | MEV protection for swaps via Jito tips |

## Develop

```bash
npm i
npm test              # 47 tests, mocked RPC and Jupiter
npm run typecheck
npm run gen:skill     # regenerate skills/ from the command registry
SMOKE_HOME=$(mktemp -d) npm run smoke   # drive the MCP server over stdio
```

Why this shape, and why it is built to win regardless of which wallet wins: [docs/strategy.md](docs/strategy.md).

MIT.
