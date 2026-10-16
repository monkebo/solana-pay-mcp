#!/usr/bin/env bash
# Run the vault + a cloudflared tunnel so claude.ai (phone) can reach it as a custom connector.
# Usage: bash scripts/phone.sh            stop: bash scripts/phone.sh stop
set -euo pipefail
cd "$(dirname "$0")/.."
HOME_DIR="${SAW_HOME:-$HOME/.solana-pay-mcp}"
mkdir -p -m 700 "$HOME_DIR"
if [[ "${1:-}" == "stop" ]]; then pkill -f "dist/saw.js vault" || true; pkill -f "cloudflared tunnel" || true; echo stopped; exit 0; fi
pkill -f "dist/saw.js vault" 2>/dev/null || true
pkill -f "cloudflared tunnel" 2>/dev/null || true
nohup cloudflared tunnel --url http://localhost:3000 > "$HOME_DIR/tunnel.log" 2>&1 &
for _ in $(seq 1 30); do URL=$(grep -ao 'https://[a-z0-9-]*\.trycloudflare\.com' "$HOME_DIR/tunnel.log" | head -1 || true); [[ -n "$URL" ]] && break; sleep 1; done
[[ -n "${URL:-}" ]] || { echo "tunnel did not come up:"; tail -20 "$HOME_DIR/tunnel.log"; exit 1; }
SOLANA_CLUSTER="${SOLANA_CLUSTER:-devnet}" SAW_PUBLIC_URL="$URL" PORT=3000 nohup node dist/saw.js vault serve > "$HOME_DIR/vault.log" 2>&1 &
sleep 1
echo "owner console:  $URL/        (token: $HOME_DIR/owner-token)"
echo "agent sign-in:  SAW_VAULT_URL=$URL saw auth signin"
echo "claude.ai connector URL: $URL/mcp  with header Authorization: Bearer <agent session token>"
