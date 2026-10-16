# Authentication

Sign-in issues a session token. In local mode (agent on the owner's machine, `requirePairingApproval=false`) `auth verify` approves itself. In vault mode the owner approves the 6-digit code in the console or with `saw owner approve-pairing`.

### `auth signin`

Start the agent sign-in. Shows a 6-digit pairing code the owner approves (vault UI or `saw owner approve-pairing`). Follow with `auth verify`.

- Access: public

```bash
saw auth signin [--label <label>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--label` | No | Optional label for this agent session, e.g. 'claude-code laptop' |

### `auth verify`

Poll the pairing started by `auth signin`. Blocks until the owner approves (or 5 minutes). On success returns the session token once; the CLI/MCP client stores it.

- Access: public

```bash
saw auth verify --qrCodeId <qrCodeId> [--wait <wait>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--qrCodeId` | Yes | qrCodeId from `auth signin` |
| `--wait` | No |  |

### `auth signout`

Sign out of the wallet and clear the local session. The agent loses all access until the owner approves a new pairing.

- Access: public

```bash
saw auth signout --json
```
