# Owner commands

Never callable with an agent session. The owner runs these on the vault host or in the owner console. Agents may tell the user which owner command would unblock them.

### `owner keygen`

Create the agent wallet keypair on this machine (0600). Fund it with a little SOL for fees plus the tokens the agent may spend.

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner keygen --json
```

### `owner policy`

Show the full security policy as stored.

- Access: owner

```bash
saw owner policy --json
```

### `owner set-policy`

Set policy fields: `saw owner set-policy dailyLimitUsd=200 addressBookOnly=false devMode.enabled=true`. Values are JSON (numbers, true/false, arrays) or plain strings.

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner set-policy --assignments <assignments> --json
```

| Parameter | Required | Description |
|---|---|---|
| `--assignments` | Yes | field=value pairs |

### `owner dev-mode`

Enable external signing (contract-call, sign-message) for a limited time with its own daily USD limit, or disable it.

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner dev-mode [--enabled <enabled>] [--hours <hours>] [--dailyLimitUsd <dailyLimitUsd>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--enabled` | No |  |
| `--hours` | No | How long it stays enabled (default 24) |
| `--dailyLimitUsd` | No | Developer-mode daily limit in USD |

### `owner pairings`

Agents waiting for sign-in approval.

- Access: owner

```bash
saw owner pairings --json
```

### `owner approve-pairing`

Approve an agent sign-in by the 6-digit code shown on the agent's screen.

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner approve-pairing --pairingCode <pairingCode> --json
```

| Parameter | Required | Description |
|---|---|---|
| `--pairingCode` | Yes | 6-digit pairing code |

### `owner reject-pairing`

Reject an agent sign-in request.

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner reject-pairing --pairingCode <pairingCode> --json
```

| Parameter | Required | Description |
|---|---|---|
| `--pairingCode` | Yes | 6-digit pairing code |

### `owner sessions`

List signed-in agents.

- Access: owner

```bash
saw owner sessions --json
```

### `owner revoke-sessions`

Revoke all agent sessions immediately.

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner revoke-sessions --json
```

### `owner contacts`

List saved recipients.

- Access: owner

```bash
saw owner contacts --json
```

### `owner add-contact`

Save a name for a wallet address. With policy.addressBookOnly the agent can only send to saved contacts.

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner add-contact --name <name> --address <address> --json
```

| Parameter | Required | Description |
|---|---|---|
| `--name` | Yes | Short name, e.g. kevin |
| `--address` | Yes | Solana address |

### `owner remove-contact`

Remove a saved contact.

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner remove-contact --name <name> --json
```

| Parameter | Required | Description |
|---|---|---|
| `--name` | Yes | Contact name |

### `owner pending`

Transactions the agent proposed that need the owner's approval.

- Access: owner

```bash
saw owner pending --json
```

### `owner approve`

Execute an order that was waiting for confirmation.

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner approve --orderId <orderId> --json
```

| Parameter | Required | Description |
|---|---|---|
| `--orderId` | Yes | Order id from `owner pending` |

### `owner reject`

Reject an order that was waiting for confirmation.

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner reject --orderId <orderId> [--reason <reason>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--orderId` | Yes | Order id |
| `--reason` | No | Optional reason shown to the agent |

### `owner status`

Key presence, address, active sessions, pending confirmations.

- Access: owner

```bash
saw owner status --json
```

### `owner backends`

Which wallets this control plane can execute through, and which one is active.

- Access: owner

```bash
saw owner backends --json
```

### `owner set-backend`

Route every agent command to a different wallet: local (self-custody key), baw (Binance Agentic Wallet CLI), signer (HTTP remote signer: --url, --token, --address), solana-pay (a human's wallet: --address). Agents keep working unchanged.

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner set-backend --kind <kind> [--url <url>] [--token <token>] [--address <address>] [--bin <bin>] [--label <label>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--kind` | Yes |  |
| `--url` | No | signer: base URL |
| `--token` | No | signer: bearer token |
| `--address` | No | signer/solana-pay: wallet address |
| `--bin` | No | baw: path to the baw binary |
| `--label` | No | solana-pay: label |
