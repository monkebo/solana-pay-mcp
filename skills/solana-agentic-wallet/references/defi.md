# DeFi (forwarded to the Binance backend)

Available when the owner has set the backend to `baw`; the same flags as Binance's `baw defi ...`, run under this wallet's `defi` daily limit. Other backends return VENUE_UNAVAILABLE.

### `defi protocol-list`

List DeFi protocols (TVL / APY). Available when the backend is Binance Agentic Wallet (forwarded to `baw defi protocol-list` with the same flags, under this wallet's defi daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: defi · forwarded to `baw` on the Binance backend

```bash
saw defi protocol-list --json
```

Additional flags are passed through unchanged.

### `defi protocol-info`

DeFi protocol details. Available when the backend is Binance Agentic Wallet (forwarded to `baw defi protocol-info` with the same flags, under this wallet's defi daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: defi · forwarded to `baw` on the Binance backend

```bash
saw defi protocol-info --json
```

Additional flags are passed through unchanged.

### `defi investment-list`

List DeFi investments (Earn / LiquidityPool). Available when the backend is Binance Agentic Wallet (forwarded to `baw defi investment-list` with the same flags, under this wallet's defi daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: defi · forwarded to `baw` on the Binance backend

```bash
saw defi investment-list --json
```

Additional flags are passed through unchanged.

### `defi investment-info`

DeFi investment details. Available when the backend is Binance Agentic Wallet (forwarded to `baw defi investment-info` with the same flags, under this wallet's defi daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: defi · forwarded to `baw` on the Binance backend

```bash
saw defi investment-info --json
```

Additional flags are passed through unchanged.

### `defi position`

My DeFi positions. Available when the backend is Binance Agentic Wallet (forwarded to `baw defi position` with the same flags, under this wallet's defi daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: defi · forwarded to `baw` on the Binance backend

```bash
saw defi position --json
```

Additional flags are passed through unchanged.

### `defi preview`

Preview a DeFi transaction. Available when the backend is Binance Agentic Wallet (forwarded to `baw defi preview` with the same flags, under this wallet's defi daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: defi · forwarded to `baw` on the Binance backend

```bash
saw defi preview --json
```

Additional flags are passed through unchanged.

### `defi deposit`

Deposit / stake / supply. Available when the backend is Binance Agentic Wallet (forwarded to `baw defi deposit` with the same flags, under this wallet's defi daily limit). No native Solana venue is wired yet for other backends.

- Access: session · **state-changing: confirm with the user first** · quota: defi · forwarded to `baw` on the Binance backend

```bash
saw defi deposit --json
```

Additional flags are passed through unchanged.

### `defi redeem`

Redeem / unstake / withdraw. Available when the backend is Binance Agentic Wallet (forwarded to `baw defi redeem` with the same flags, under this wallet's defi daily limit). No native Solana venue is wired yet for other backends.

- Access: session · **state-changing: confirm with the user first** · quota: defi · forwarded to `baw` on the Binance backend

```bash
saw defi redeem --json
```

Additional flags are passed through unchanged.

### `defi lp-add`

Add liquidity. Available when the backend is Binance Agentic Wallet (forwarded to `baw defi lp-add` with the same flags, under this wallet's defi daily limit). No native Solana venue is wired yet for other backends.

- Access: session · **state-changing: confirm with the user first** · quota: defi · forwarded to `baw` on the Binance backend

```bash
saw defi lp-add --json
```

Additional flags are passed through unchanged.

### `defi lp-remove`

Remove liquidity. Available when the backend is Binance Agentic Wallet (forwarded to `baw defi lp-remove` with the same flags, under this wallet's defi daily limit). No native Solana venue is wired yet for other backends.

- Access: session · **state-changing: confirm with the user first** · quota: defi · forwarded to `baw` on the Binance backend

```bash
saw defi lp-remove --json
```

Additional flags are passed through unchanged.

### `defi claim`

Claim rewards / matured redemptions. Available when the backend is Binance Agentic Wallet (forwarded to `baw defi claim` with the same flags, under this wallet's defi daily limit). No native Solana venue is wired yet for other backends.

- Access: session · **state-changing: confirm with the user first** · quota: defi · forwarded to `baw` on the Binance backend

```bash
saw defi claim --json
```

Additional flags are passed through unchanged.
