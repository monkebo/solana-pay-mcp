#!/usr/bin/env bash
# Start the HTTP MCP server + a cloudflared tunnel so claude.ai (and the phone app) can reach it.
# Usage: bash scripts/phone.sh        (stop with: bash scripts/phone.sh stop)
set -euo pipefail
cd "$(dirname "$0")/.."
LOG=~/.solana-pay-mcp
mkdir -p -m 700 "$LOG"

if [[ "${1:-}" == "server" ]]; then
  pkill -f "dist/index.js serve" || true
  SOLANA_PAY_HTTP_SECRET="$(cat "$LOG/http-secret")" SOLANA_PAY_RECIPIENT=GG6uob9Gn8sTojdK6w2vXeoSqft82reYaTvAzZtrdNuf SOLANA_CLUSTER=devnet SOLANA_PAY_SIGNER="$HOME/.solana-pay-mcp/agent.json" SOLANA_PAY_DAILY_CAP=10 SOLANA_PAY_DAILY_CAP_SOL=1 PORT=3000 nohup node dist/index.js serve > "$LOG/serve.log" 2>&1 &
  echo "server restarted, tunnel URL unchanged"; exit 0
fi

if [[ "${1:-}" == "stop" ]]; then
  pkill -f "dist/index.js serve" || true
  pkill -f "cloudflared tunnel" || true
  echo stopped; exit 0
fi

[[ -f "$LOG/http-secret" ]] || (umask 077; openssl rand -hex 24 > "$LOG/http-secret")
SECRET=$(cat "$LOG/http-secret")

pkill -f "dist/index.js serve" 2>/dev/null || true
pkill -f "cloudflared tunnel" 2>/dev/null || true

SOLANA_PAY_HTTP_SECRET="$SECRET" \
SOLANA_PAY_RECIPIENT=GG6uob9Gn8sTojdK6w2vXeoSqft82reYaTvAzZtrdNuf \
SOLANA_CLUSTER=devnet \
SOLANA_PAY_SIGNER="$HOME/.solana-pay-mcp/agent.json" \
SOLANA_PAY_DAILY_CAP=10 SOLANA_PAY_DAILY_CAP_SOL=1 PORT=3000 \
nohup node dist/index.js serve > "$LOG/serve.log" 2>&1 &

nohup cloudflared tunnel --url http://localhost:3000 > "$LOG/tunnel.log" 2>&1 &

for _ in $(seq 1 30); do
  URL=$(grep -ao 'https://[a-z0-9-]*\.trycloudflare\.com' "$LOG/tunnel.log" | head -1 || true)
  [[ -n "$URL" ]] && break
  sleep 1
done
[[ -n "${URL:-}" ]] || { echo "tunnel did not come up:"; tail -20 "$LOG/tunnel.log"; exit 1; }

echo "CONNECTOR URL (paste into claude.ai -> Settings -> Connectors -> Add custom connector):"
echo "$URL/mcp/$SECRET"
