# Limit orders (Jupiter trigger orders)

A `strategyId` is a placement, not a fill. WORKING is the normal resting state; do not poll it to completion. Minimum $5 input.

### `limit-order buy`

Buy a token with USDC, USDT or SOL when its USD price drops to triggerPrice. Places a Jupiter trigger order (min $5). A strategyId is a placement, not a fill.

- Access: session · **state-changing: confirm with the user first** · forwarded to `baw` on the Binance backend

```bash
saw limit-order buy --triggerPrice <triggerPrice> --fromTokenQty <fromTokenQty> --fromToken <fromToken> --toToken <toToken> [--binanceChainId <binanceChainId>] [--slippage <slippage>] [--mev <mev>] [--gasLevel <gasLevel>] [--expiredAt <expiredAt>] [--orderId <orderId>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--triggerPrice` | Yes | USD price that activates the order |
| `--fromTokenQty` | Yes | Amount of fromToken |
| `--fromToken` | Yes | Mint or SOL/USDC/USDT |
| `--toToken` | Yes | Mint or SOL/USDC/USDT |
| `--binanceChainId` | No | Ignored |
| `--slippage` | No | "auto" (default) or percent 0–100, e.g. 2.5 |
| `--mev` | No |  |
| `--gasLevel` | No | Priority fee tier (default MEDIUM) |
| `--expiredAt` | No | Optional expiry, ms timestamp |
| `--orderId` | No | internal |

### `limit-order sell`

Sell a token for USDC, USDT or SOL when its USD price reaches triggerPrice. Places a Jupiter trigger order (min $5). A strategyId is a placement, not a fill.

- Access: session · **state-changing: confirm with the user first** · forwarded to `baw` on the Binance backend

```bash
saw limit-order sell --triggerPrice <triggerPrice> --fromTokenQty <fromTokenQty> --fromToken <fromToken> --toToken <toToken> [--binanceChainId <binanceChainId>] [--slippage <slippage>] [--mev <mev>] [--gasLevel <gasLevel>] [--expiredAt <expiredAt>] [--orderId <orderId>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--triggerPrice` | Yes | USD price that activates the order |
| `--fromTokenQty` | Yes | Amount of fromToken |
| `--fromToken` | Yes | Mint or SOL/USDC/USDT |
| `--toToken` | Yes | Mint or SOL/USDC/USDT |
| `--binanceChainId` | No | Ignored |
| `--slippage` | No | "auto" (default) or percent 0–100, e.g. 2.5 |
| `--mev` | No |  |
| `--gasLevel` | No | Priority fee tier (default MEDIUM) |
| `--expiredAt` | No | Optional expiry, ms timestamp |
| `--orderId` | No | internal |

### `limit-order list`

Resting and historical trigger orders: WORKING, TRIGGERED, PENDING, FINISHED, FAILED, EXPIRED, CANCELED. Live status comes from Jupiter; falls back to local records offline.

- Access: session · forwarded to `baw` on the Binance backend

```bash
saw limit-order list [--strategyId <strategyId>] [--status <status>] [--fromToken <fromToken>] [--toToken <toToken>] [--startTime <startTime>] [--endTime <endTime>] [--page <page>] [--pageSize <pageSize>] [--binanceChainId <binanceChainId>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--strategyId` | No | One order (Jupiter order account) |
| `--status` | No |  |
| `--fromToken` | No | Filter |
| `--toToken` | No | Filter |
| `--startTime` | No | ms |
| `--endTime` | No | ms |
| `--page` | No | 1-based |
| `--pageSize` | No | Max 100 |
| `--binanceChainId` | No | Ignored |

### `limit-order cancel`

Cancel a resting trigger order and get the escrowed tokens back.

- Access: session · **state-changing: confirm with the user first** · forwarded to `baw` on the Binance backend

```bash
saw limit-order cancel --strategyId <strategyId> [--orderId <orderId>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--strategyId` | Yes | Order account from `limit-order list` |
| `--orderId` | No | internal |
