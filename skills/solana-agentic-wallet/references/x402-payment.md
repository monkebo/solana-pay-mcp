# x402 payments

Buyer side of HTTP 402. `preview` ranks options; `sign` returns the header to replay with (one use, ~60 s). `pay` does the whole loop for one URL. Confirm with the user before signing, before switching options, and before paying for a different resource.

### `x402-payment preview`

Parse a merchant's PaymentRequired (base64 PAYMENT-REQUIRED header or raw JSON) and rank the options: READY_TO_SIGN, ACTION_REQUIRED (e.g. insufficient balance), NOT_SIGNABLE (other chains, over x402 daily limit, token not allowed).

- Access: session

```bash
saw x402-payment preview --paymentRequirements <paymentRequirements> --json
```

| Parameter | Required | Description |
|---|---|---|
| `--paymentRequirements` | Yes | PaymentRequired JSON or base64 header value |

### `x402-payment sign`

Sign the selected option from preview. Returns the header to replay the original request with (PAYMENT-SIGNATURE for v2, X-PAYMENT for v1). One use, valid ~60 s; the merchant settles it. Counts against the x402 daily limit.

- Access: session · **state-changing: confirm with the user first**

```bash
saw x402-payment sign --paymentId <paymentId> --selectedIndex <selectedIndex> [--orderId <orderId>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--paymentId` | Yes | From preview |
| `--selectedIndex` | Yes | 1-based option index |
| `--orderId` | No | internal |

### `x402-payment pay`

Request a URL; on HTTP 402 preview the options, sign the best READY_TO_SIGN one (within policy) and replay with the payment header. Returns the response body (truncated) and the decoded settlement header. Confirm with the user before running: it spends.

- Access: session · **state-changing: confirm with the user first**

```bash
saw x402-payment pay --url <url> [--method <method>] [--body <body>] [--maxChars <maxChars>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--url` | Yes | Resource URL |
| `--method` | No |  |
| `--body` | No | Request body for POST |
| `--maxChars` | No | Max response characters returned (default 4000) |

### `x402-payment list`

Payments signed by this wallet with amounts and settlement signatures when known.

- Access: session

```bash
saw x402-payment list [--limit <limit>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--limit` | No | Default 20 |
