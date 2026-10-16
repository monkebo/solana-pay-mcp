# External signing (Developer Mode)

Two-step: `preview` parses, simulates and scores risk; `execute` takes the `requestId` within 10 minutes. Developer Mode is enabled by the owner only. Show `balanceChanges`, `authorityChanges` and `risks` before asking the user to confirm.

### `contract-call preview`

Developer mode. Decode, simulate and risk-score an unsigned base64 transaction built by a dApp or SDK: programs called, balance changes, authority changes. Returns a requestId for execute (10 minutes).

- Access: session · quota: devMode · forwarded to `baw` on the Binance backend

```bash
saw contract-call preview [--binanceChainId <binanceChainId>] [--from <from>] --unsignedTx <unsignedTx> [--to <to>] [--value <value>] [--inputData <inputData>] [--gasLimit <gasLimit>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--binanceChainId` | No | Ignored |
| `--from` | No | Must be this wallet's address if given |
| `--unsignedTx` | Yes | Unsigned transaction, base64 |
| `--to` | No | EVM only; ignored |
| `--value` | No | EVM only; ignored |
| `--inputData` | No | EVM only; ignored |
| `--gasLimit` | No | EVM only; rejected |

### `contract-call execute`

Sign and broadcast a transaction previewed with contract-call preview. Counts the simulated USD outflow against the developer-mode daily limit; risky previews wait for owner confirmation.

- Access: session · **state-changing: confirm with the user first** · quota: devMode · forwarded to `baw` on the Binance backend

```bash
saw contract-call execute --requestId <requestId> [--orderId <orderId>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--requestId` | Yes | From contract-call preview |
| `--orderId` | No | internal |

### `sign-message preview`

Developer mode. Parse a message to sign: SOLANA_OFFCHAIN (the Solana off-chain message standard, safe by construction) or RAW (plain bytes, what most dApps' signMessage uses). Returns a requestId for execute.

- Access: session · quota: devMode · forwarded to `baw` on the Binance backend

```bash
saw sign-message preview [--binanceChainId <binanceChainId>] --message <message> [--signType <signType>] [--applicationDomain <applicationDomain>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--binanceChainId` | No | Ignored |
| `--message` | Yes | Message text (or JSON string) |
| `--signType` | No | SOLANA_OFFCHAIN (default) \| RAW |
| `--applicationDomain` | No | Off-chain standard application domain (base58, 32 bytes) |

### `sign-message execute`

Produce the signature for a message previewed with sign-message preview. Risky previews wait for owner confirmation; fetch the result later with sign-message result.

- Access: session · **state-changing: confirm with the user first** · quota: devMode · forwarded to `baw` on the Binance backend

```bash
saw sign-message execute --requestId <requestId> [--orderId <orderId>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--requestId` | Yes | From sign-message preview |
| `--orderId` | No | internal |

### `sign-message result`

Status of a sign-message order: COMPLETED with the signature, PENDING_CONFIRMATION, REJECTED or EXPIRED.

- Access: session · quota: devMode · forwarded to `baw` on the Binance backend

```bash
saw sign-message result --orderId <orderId> --json
```

| Parameter | Required | Description |
|---|---|---|
| `--orderId` | Yes | Order id from sign-message execute |

### `sign-message history`

Messages this wallet has signed.

- Access: session · quota: devMode · forwarded to `baw` on the Binance backend

```bash
saw sign-message history [--binanceChainId <binanceChainId>] [--limit <limit>] [--nextToken <nextToken>] [--startTime <startTime>] [--endTime <endTime>] [--sortType <sortType>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--binanceChainId` | No | Ignored |
| `--limit` | No | Default 20 |
| `--nextToken` | No | Pagination cursor (signatureTime) |
| `--startTime` | No | ms |
| `--endTime` | No | ms |
| `--sortType` | No |  |
