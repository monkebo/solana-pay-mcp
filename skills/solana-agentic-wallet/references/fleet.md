# Fleet (owner)

Many agents under one owner: each has its own key, policy overrides, quotas and lock, and all share one ledger. Agents are paused or killed by the owner; a paused agent gets AGENT_PAUSED, a paused fleet FLEET_PAUSED.

### `owner fleet create`

Create N agents, each with its own key, policy overrides and session token. Agents are added to the address book by name so they can pay each other. Returns each agent's session token once: hand it to the agent process (SAW_VAULT_URL + `auth` is not needed; the token is the session).

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner fleet create --role <role> [--count <count>] [--name <name>] [--dailyLimitUsd <dailyLimitUsd>] [--maxPaymentUsd <maxPaymentUsd>] [--addressBookOnly <addressBookOnly>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--role` | Yes | Group label, e.g. translator, buyer, researcher |
| `--count` | No | How many to create (default 1) |
| `--name` | No | Name for a single agent (default <role>-NN) |
| `--dailyLimitUsd` | No | Per-agent daily USD limit (default: owner policy) |
| `--maxPaymentUsd` | No | Per-agent max USD per payment (default: owner policy) |
| `--addressBookOnly` | No |  |

### `owner fleet list`

Every agent with status, spend today against its limit, sessions, and (with --balances) on-chain SOL and USDC.

- Access: owner

```bash
saw owner fleet list [--role <role>] [--balances <balances>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--role` | No | Filter by role |
| `--balances` | No |  |

### `owner fleet fund`

Send USDC (and a little SOL for fees) from the owner's treasury key to every active agent, 5 agents per transaction.

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner fleet fund --amount <amount> [--sol <sol>] [--role <role>] [--name <name>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--amount` | Yes | USDC per agent |
| `--sol` | No | SOL per agent for fees (default 0.01) |
| `--role` | No | Only agents with this role |
| `--name` | No | Only this agent |

### `owner fleet pause`

Stop one agent, a whole role, or the entire fleet from spending. Sessions stay valid; every write is refused with AGENT_PAUSED / FLEET_PAUSED.

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner fleet pause --target <target> [--reason <reason>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--target` | Yes | Agent name, agent id, a role, or `all` |
| `--reason` | No | Shown to the agent in the error |

### `owner fleet resume`

Let paused agents (or the whole fleet) spend again. Killed agents stay killed.

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner fleet resume --target <target> --json
```

| Parameter | Required | Description |
|---|---|---|
| `--target` | Yes | Agent name, agent id, a role, or `all` |

### `owner fleet kill`

Permanent: revokes the agent's sessions and refuses every future action. The key file stays so the owner can sweep remaining funds.

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner fleet kill --target <target> [--reason <reason>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--target` | Yes | Agent name, agent id, a role, or `all` |
| `--reason` | No | Why |

### `owner fleet set-policy`

Override policy for one agent, a role, or all: `saw owner fleet set-policy translator dailyLimitUsd=0.5 maxPaymentUsd=0.1`. Allowed: dailyLimitUsd, maxPaymentUsd, x402DailyLimitUsd, allowedTokens, tradeAllTokens, addressBookOnly, confirmAboveUsd.

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner fleet set-policy --target <target> --assignments <assignments> --json
```

| Parameter | Required | Description |
|---|---|---|
| `--target` | Yes | Agent name, agent id, a role, or `all` |
| `--assignments` | Yes | field=value pairs |

### `owner fleet rename`

Give an agent a new name and/or role. Keys, balances, sessions and history stay; the address-book entry follows the name.

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner fleet rename --target <target> [--name <name>] [--role <role>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--target` | Yes | Current agent name or id |
| `--name` | No | New name |
| `--role` | No | New role |

### `owner fleet token`

Revoke the agent's current sessions and issue a fresh token (shown once).

- Access: owner · **state-changing: confirm with the user first**

```bash
saw owner fleet token --target <target> --json
```

| Parameter | Required | Description |
|---|---|---|
| `--target` | Yes | Agent name or id |

### `owner fleet ledger`

Latest orders across every agent and the treasury: who paid whom, how much, status, transaction.

- Access: owner

```bash
saw owner fleet ledger [--limit <limit>] [--agent <agent>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--limit` | No | Rows (default 50, max 500) |
| `--agent` | No | Only this agent name |
