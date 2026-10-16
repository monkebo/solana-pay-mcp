# Wallet

Status, balances, history, settings, sends. A `txHash` means broadcast, not confirmed: tell the user it is pending and check `wallet tx-history --tx <hash>` or `wallet tx-lock`.

### `wallet status`

UNCONNECTED (not signed in), CREATING (signed in, no key yet), CONNECTED (ready).

- Access: public

```bash
saw wallet status --json
```

### `wallet chains`

Networks this wallet supports. One: Solana (CT_501), mainnet or devnet per SOLANA_CLUSTER.

- Access: public

```bash
saw wallet chains --json
```

### `wallet address`

The agent wallet's address.

- Access: session

```bash
saw wallet address --json
```

### `wallet settings`

Read-only view of the policy and remaining daily quotas. Settings change only on the owner side.

- Access: session

```bash
saw wallet settings --json
```

### `wallet tx-lock`

LOCKED while a transaction is pending on-chain or an order waits for owner confirmation; UNLOCKED otherwise.

- Access: session

```bash
saw wallet tx-lock [--binanceChainId <binanceChainId>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--binanceChainId` | No |  |

### `wallet contacts`

Saved recipients the agent may send to. Managed by the owner.

- Access: session

```bash
saw wallet contacts --json
```

### `wallet balance`

SOL and every token the wallet holds, with USD prices and values. Tokens worth less than $0.01 are hidden unless --includeDust.

- Access: session

```bash
saw wallet balance [--symbol <symbol>] [--tokenAddress <tokenAddress>] [--binanceChainId <binanceChainId>] [--includeDust <includeDust>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--symbol` | No | Filter by symbol, e.g. USDC |
| `--tokenAddress` | No | Filter by mint address |
| `--binanceChainId` | No | Ignored; Solana only |
| `--includeDust` | No |  |

### `wallet tx-history`

Recent transactions of the wallet from the chain, plus pending ones this wallet broadcast. Cursor-paginated.

- Access: session

```bash
saw wallet tx-history [--type <type>] [--size <size>] [--nextCursor <nextCursor>] [--tx <tx>] [--startTime <startTime>] [--endTime <endTime>] [--binanceChainId <binanceChainId>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--type` | No | all (default) \| pending \| confirmed |
| `--size` | No | Page size, max 100 |
| `--nextCursor` | No | Cursor from a previous page |
| `--tx` | No | Look up one transaction signature |
| `--startTime` | No | ms timestamp |
| `--endTime` | No | ms timestamp |
| `--binanceChainId` | No | Ignored; Solana only |

### `wallet gas-price`

LOW / MEDIUM / HIGH priority-fee tiers from recent blocks (micro-lamports per compute unit) and the tip in SOL they imply for a typical 200k-CU transaction. A snapshot, not a quote.

- Access: session

```bash
saw wallet gas-price [--binanceChainId <binanceChainId>] [--tokenAddress <tokenAddress>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--binanceChainId` | No | Ignored; Solana only |
| `--tokenAddress` | No | Optional mint to scope fees to transactions touching it |

### `wallet send`

Transfer SOL or any SPL token to a saved contact or address. Enforces allowed tokens, per-payment and daily USD limits, and address-book-only sends; risky transfers go to the owner for confirmation. Returns a txHash once broadcast (not yet confirmed).

- Access: session · **state-changing: confirm with the user first**

```bash
saw wallet send [--amount <amount>] [--max <max>] --recipient <recipient> --tokenAddress <tokenAddress> [--binanceChainId <binanceChainId>] [--gasLevel <gasLevel>] [--memo <memo>] [--reference <reference>] [--dryRun <dryRun>] [--orderId <orderId>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--amount` | No |  |
| `--max` | No |  |
| `--recipient` | Yes | Saved contact name or Solana address |
| `--tokenAddress` | Yes | Mint address, or SOL / USDC / USDT |
| `--binanceChainId` | No | Ignored; Solana only |
| `--gasLevel` | No | Priority fee tier (default MEDIUM) |
| `--memo` | No | On-chain memo, max 200 chars |
| `--reference` | No | Solana Pay reference account to attach (payee lookups) |
| `--dryRun` | No |  |
| `--orderId` | No | internal: replay of an approved order |

### `wallet speed-up`

Resend a transaction this wallet broadcast that has not landed yet. Solana has no fee bumping of a signed transaction, so this rebroadcasts the same bytes while its blockhash is valid (~60–90 s); after that it has expired and must be sent again.

- Access: session · **state-changing: confirm with the user first**

```bash
saw wallet speed-up --txHash <txHash> [--level <level>] [--binanceChainId <binanceChainId>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--txHash` | Yes | Signature of the pending transaction |
| `--level` | No | Accepted for compatibility; ignored on Solana |
| `--binanceChainId` | No | Ignored |

### `wallet cancel`

Not possible on Solana: there is no nonce replacement. A broadcast transaction either lands within its blockhash window (~60–90 s) or expires by itself. Returns a clear error.

- Access: session

```bash
saw wallet cancel --txHash <txHash> [--binanceChainId <binanceChainId>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--txHash` | Yes | Signature |
| `--binanceChainId` | No | Ignored |

### `wallet pay-many`

Batch payments: payroll, bounties, splits. Each item is a contact or address, an amount and a memo. Runs as sequential `wallet send`s under policy; stops at the first failure. Items needing owner confirmation are queued.

- Access: session · **state-changing: confirm with the user first**

```bash
saw wallet pay-many --payments <payments> [--tokenAddress <tokenAddress>] [--dryRun <dryRun>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--payments` | Yes | JSON array of {to, amount, memo} |
| `--tokenAddress` | No | Mint or SOL/USDC/USDT (default USDC) |
| `--dryRun` | No |  |
