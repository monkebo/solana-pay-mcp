# Token lookup and audit

Never fabricate a mint address. Resolve symbols with `token search`, show the full mint next to the symbol, and run `token audit` before trading a token that is not SOL, USDC or USDT.

### `token search`

Find tokens by symbol, name or mint via Jupiter. Always show the full mint address next to a symbol; never pick a token by name alone.

- Access: public

```bash
saw token search --query <query> [--limit <limit>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--query` | Yes | Symbol, name or mint |
| `--limit` | No | Max results (default 10) |

### `token audit`

Risk flags for a token before trading it: verification, mint/freeze authority, holder concentration, liquidity, organic score. hasResult=false means no data; do not infer safety from that.

- Access: public

```bash
saw token audit --tokenAddress <tokenAddress> --json
```

| Parameter | Required | Description |
|---|---|---|
| `--tokenAddress` | Yes | Mint or SOL/USDC/USDT |
