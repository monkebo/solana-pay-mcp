# Receiving: invoices and the ledger

Invoices carry a fresh reference key. `invoice status` reports UNPAID, CONFIRMED or SETTLED with confidence `exact` (reference key) or `probable` (matching inflow). `ledger rebuild` re-derives everything from the chain.

### `invoice create`

Invoice a client in USDC on Solana. Returns a Solana Pay link and QR that any wallet can pay (Phantom, Solflare, Backpack, Binance). Money goes straight to this wallet (or SOLANA_PAY_RECIPIENT). Follow with `invoice status`.

- Access: session

```bash
saw invoice create --amount <amount> --memo <memo> --json
```

| Parameter | Required | Description |
|---|---|---|
| `--amount` | Yes | USDC amount, e.g. 3000 or 12.50 |
| `--memo` | Yes | What it is for (max 120 chars) |

### `invoice status`

Look on-chain for the payment. UNPAID, CONFIRMED (seen) or SETTLED (finalized), with confidence exact (reference key) or probable (matching inflow) and the payer when identifiable.

- Access: session

```bash
saw invoice status --id <id> --json
```

| Parameter | Required | Description |
|---|---|---|
| `--id` | Yes | Invoice id, e.g. inv_1a2b3c4d |

### `invoice list`

All invoices with their settlement state.

- Access: session

```bash
saw invoice list [--limit <limit>] [--unpaid <unpaid>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--limit` | No | Default 50 |
| `--unpaid` | No |  |

### `ledger rebuild`

Drop cached settlement for every invoice and re-derive it from Solana. Lets anyone verify the ledger is not fabricated.

- Access: session

```bash
saw ledger rebuild --json
```

### `ledger list`

Everything this control plane did, across all backends: sends, swaps, orders, x402, external signatures, forwarded DeFi. Plus invoices received.

- Access: session

```bash
saw ledger list [--limit <limit>] [--kind <kind>] [--backend <backend>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--limit` | No | Default 50 |
| `--kind` | No | Filter by kind: send \| swap \| limit \| x402 \| contract-call \| sign-message \| defi \| prediction \| revoke |
| `--backend` | No | Filter by backend |

### `ledger export`

CSV of outgoing orders and incoming invoices for a period, for accountants.

- Access: session

```bash
saw ledger export [--startTime <startTime>] [--endTime <endTime>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--startTime` | No | ms timestamp |
| `--endTime` | No | ms timestamp |
