# Market orders (Jupiter swaps)

An `orderId` is a submission, not a fill. Poll `market-order list --orderId <id>` until FINISHED or FAILED before reporting.

### `market-order quote`

Price a swap without trading: expected output, minimum received at the slippage, price impact, route.

- Access: session

```bash
saw market-order quote --fromTokenQty <fromTokenQty> --fromToken <fromToken> --toToken <toToken> [--binanceChainId <binanceChainId>] [--slippage <slippage>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--fromTokenQty` | Yes | Amount of fromToken |
| `--fromToken` | Yes | Mint or SOL/USDC/USDT |
| `--toToken` | Yes | Mint or SOL/USDC/USDT |
| `--binanceChainId` | No | Ignored |
| `--slippage` | No | "auto" (default) or percent 0–100, e.g. 2.5 |

### `market-order swap`

Swap tokens through Jupiter at the current price. Policy checks: allowed tokens, per-tx and daily USD limits, token audit; risky swaps go to the owner. Returns an orderId: poll `market-order list --orderId` until FINISHED or FAILED.

- Access: session · **state-changing: confirm with the user first**

```bash
saw market-order swap --fromTokenQty <fromTokenQty> --fromToken <fromToken> --toToken <toToken> [--binanceChainId <binanceChainId>] [--slippage <slippage>] [--mev <mev>] [--gasLevel <gasLevel>] [--orderId <orderId>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--fromTokenQty` | Yes | Amount of fromToken to sell |
| `--fromToken` | Yes | Mint or SOL/USDC/USDT |
| `--toToken` | Yes | Mint or SOL/USDC/USDT |
| `--binanceChainId` | No | Ignored |
| `--slippage` | No | "auto" (default) or percent 0–100, e.g. 2.5 |
| `--mev` | No |  |
| `--gasLevel` | No | Priority fee tier (default MEDIUM) |
| `--orderId` | No | internal |

### `market-order list`

Swaps placed by this wallet with PENDING / FINISHED / FAILED status (refreshed from the chain).

- Access: session

```bash
saw market-order list [--orderId <orderId>] [--status <status>] [--fromToken <fromToken>] [--toToken <toToken>] [--startTime <startTime>] [--endTime <endTime>] [--page <page>] [--pageSize <pageSize>] [--binanceChainId <binanceChainId>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--orderId` | No | One order |
| `--status` | No |  |
| `--fromToken` | No | Filter |
| `--toToken` | No | Filter |
| `--startTime` | No | ms |
| `--endTime` | No | ms |
| `--page` | No | Page (1-based) |
| `--pageSize` | No | Max 100 |
| `--binanceChainId` | No | Ignored |
