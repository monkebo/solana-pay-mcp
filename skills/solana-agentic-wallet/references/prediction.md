# Prediction markets (forwarded to the Binance backend)

Available when the backend is `baw`; same flags as Binance's `baw prediction ...`, under the `prediction` daily limit. Other backends return VENUE_UNAVAILABLE.

### `prediction category list`

Prediction market categories. Available when the backend is Binance Agentic Wallet (forwarded to `baw prediction category list` with the same flags, under this wallet's prediction daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: prediction · forwarded to `baw` on the Binance backend

```bash
saw prediction category list --json
```

Additional flags are passed through unchanged.

### `prediction market list`

List prediction markets. Available when the backend is Binance Agentic Wallet (forwarded to `baw prediction market list` with the same flags, under this wallet's prediction daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: prediction · forwarded to `baw` on the Binance backend

```bash
saw prediction market list --json
```

Additional flags are passed through unchanged.

### `prediction market detail`

Prediction market details. Available when the backend is Binance Agentic Wallet (forwarded to `baw prediction market detail` with the same flags, under this wallet's prediction daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: prediction · forwarded to `baw` on the Binance backend

```bash
saw prediction market detail --json
```

Additional flags are passed through unchanged.

### `prediction market search`

Search prediction markets. Available when the backend is Binance Agentic Wallet (forwarded to `baw prediction market search` with the same flags, under this wallet's prediction daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: prediction · forwarded to `baw` on the Binance backend

```bash
saw prediction market search --json
```

Additional flags are passed through unchanged.

### `prediction market order-book`

Prediction order book. Available when the backend is Binance Agentic Wallet (forwarded to `baw prediction market order-book` with the same flags, under this wallet's prediction daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: prediction · forwarded to `baw` on the Binance backend

```bash
saw prediction market order-book --json
```

Additional flags are passed through unchanged.

### `prediction market last-trade-price`

Last trade price. Available when the backend is Binance Agentic Wallet (forwarded to `baw prediction market last-trade-price` with the same flags, under this wallet's prediction daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: prediction · forwarded to `baw` on the Binance backend

```bash
saw prediction market last-trade-price --json
```

Additional flags are passed through unchanged.

### `prediction position list`

My prediction positions. Available when the backend is Binance Agentic Wallet (forwarded to `baw prediction position list` with the same flags, under this wallet's prediction daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: prediction · forwarded to `baw` on the Binance backend

```bash
saw prediction position list --json
```

Additional flags are passed through unchanged.

### `prediction position token`

Position by token id. Available when the backend is Binance Agentic Wallet (forwarded to `baw prediction position token` with the same flags, under this wallet's prediction daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: prediction · forwarded to `baw` on the Binance backend

```bash
saw prediction position token --json
```

Additional flags are passed through unchanged.

### `prediction position settled-history`

Settled prediction history. Available when the backend is Binance Agentic Wallet (forwarded to `baw prediction position settled-history` with the same flags, under this wallet's prediction daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: prediction · forwarded to `baw` on the Binance backend

```bash
saw prediction position settled-history --json
```

Additional flags are passed through unchanged.

### `prediction position pnl`

Prediction PnL records. Available when the backend is Binance Agentic Wallet (forwarded to `baw prediction position pnl` with the same flags, under this wallet's prediction daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: prediction · forwarded to `baw` on the Binance backend

```bash
saw prediction position pnl --json
```

Additional flags are passed through unchanged.

### `prediction position portfolio`

Prediction portfolio summary. Available when the backend is Binance Agentic Wallet (forwarded to `baw prediction position portfolio` with the same flags, under this wallet's prediction daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: prediction · forwarded to `baw` on the Binance backend

```bash
saw prediction position portfolio --json
```

Additional flags are passed through unchanged.

### `prediction order history`

Prediction order history. Available when the backend is Binance Agentic Wallet (forwarded to `baw prediction order history` with the same flags, under this wallet's prediction daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: prediction · forwarded to `baw` on the Binance backend

```bash
saw prediction order history --json
```

Additional flags are passed through unchanged.

### `prediction trade quote`

Prediction trade quote. Available when the backend is Binance Agentic Wallet (forwarded to `baw prediction trade quote` with the same flags, under this wallet's prediction daily limit). No native Solana venue is wired yet for other backends.

- Access: session · quota: prediction · forwarded to `baw` on the Binance backend

```bash
saw prediction trade quote --json
```

Additional flags are passed through unchanged.

### `prediction trade place-order`

Place a prediction order. Available when the backend is Binance Agentic Wallet (forwarded to `baw prediction trade place-order` with the same flags, under this wallet's prediction daily limit). No native Solana venue is wired yet for other backends.

- Access: session · **state-changing: confirm with the user first** · quota: prediction · forwarded to `baw` on the Binance backend

```bash
saw prediction trade place-order --json
```

Additional flags are passed through unchanged.

### `prediction trade cancel`

Cancel a prediction order. Available when the backend is Binance Agentic Wallet (forwarded to `baw prediction trade cancel` with the same flags, under this wallet's prediction daily limit). No native Solana venue is wired yet for other backends.

- Access: session · **state-changing: confirm with the user first** · quota: prediction · forwarded to `baw` on the Binance backend

```bash
saw prediction trade cancel --json
```

Additional flags are passed through unchanged.

### `prediction trade redeem`

Redeem winning positions. Available when the backend is Binance Agentic Wallet (forwarded to `baw prediction trade redeem` with the same flags, under this wallet's prediction daily limit). No native Solana venue is wired yet for other backends.

- Access: session · **state-changing: confirm with the user first** · quota: prediction · forwarded to `baw` on the Binance backend

```bash
saw prediction trade redeem --json
```

Additional flags are passed through unchanged.
