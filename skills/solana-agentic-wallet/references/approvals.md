# Token approvals

On Solana an approval is a delegate on a token account. Unlimited delegations are flagged high risk.

### `approvals list`

Token accounts that have a delegate (spender) set, with the delegated amount. Unlimited delegations are flagged high risk.

- Access: session · forwarded to `baw` on the Binance backend

```bash
saw approvals list [--binanceChainId <binanceChainId>] [--spender <spender>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--binanceChainId` | No | Ignored; Solana only |
| `--spender` | No | Filter by delegate address |

### `approvals detail`

One delegation with the token balance, price and the approve/revoke history of that token account.

- Access: session · forwarded to `baw` on the Binance backend

```bash
saw approvals detail [--binanceChainId <binanceChainId>] --tokenContract <tokenContract> --spender <spender> [--type <type>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--binanceChainId` | No | Ignored |
| `--tokenContract` | Yes | Mint address |
| `--spender` | Yes | Delegate address |
| `--type` | No | Ignored; always delegate |

### `approvals revoke`

Remove a delegate from a token account. Broadcasts a Revoke instruction; the delegation stays active until the transaction confirms.

- Access: session · **state-changing: confirm with the user first** · forwarded to `baw` on the Binance backend

```bash
saw approvals revoke [--binanceChainId <binanceChainId>] --tokenContract <tokenContract> --spender <spender> [--type <type>] [--orderId <orderId>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--binanceChainId` | No | Ignored |
| `--tokenContract` | Yes | Mint address |
| `--spender` | Yes | Delegate address |
| `--type` | No | Ignored |
| `--orderId` | No | internal |
