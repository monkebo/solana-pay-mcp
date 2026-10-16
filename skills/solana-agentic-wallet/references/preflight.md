# Preflight

Run at the start of each conversation: skill version, CLI version, wallet status.

### `skill-check`

Compare the installed skill version with the latest published one.

- Access: public

```bash
saw skill-check [--skillName <skillName>] [--currentVersion <currentVersion>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--skillName` | No |  |
| `--currentVersion` | No |  |

### `cli-check`

Check the installed CLI meets the skill's required version.

- Access: public

```bash
saw cli-check [--requiredVersion <requiredVersion>] --json
```

| Parameter | Required | Description |
|---|---|---|
| `--requiredVersion` | No |  |
