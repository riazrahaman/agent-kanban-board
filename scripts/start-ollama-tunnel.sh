#!/usr/bin/env bash
# scripts/start-ollama-tunnel.sh
#
# Starts the local Ollama Tunnel Gateway (:11435) and Cloudflare Quick Tunnel,
# then automatically sets the tunnel URL and auth token in Railway environment variables.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TOKEN_FILE="${HOME}/.agent-grid/ollama-tunnel-token.env"
TUNNEL_LOG="/tmp/kanban-cloudflared.log"
GATEWAY_PORT=11435
GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}"

echo "=== [1/5] Checking Prerequisites & Auth Token ==="
mkdir -p "${HOME}/.agent-grid"
if [ ! -f "${TOKEN_FILE}" ]; then
  # Generate a cryptographically secure token if not present
  RANDOM_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
  echo "TUNNEL_AUTH_TOKEN=\"${RANDOM_TOKEN}\"" > "${TOKEN_FILE}"
  chmod 600 "${TOKEN_FILE}"
fi

TUNNEL_AUTH_TOKEN=$(grep '^TUNNEL_AUTH_TOKEN=' "${TOKEN_FILE}" | cut -d= -f2- | tr -d '"\r\n')
if [ -z "${TUNNEL_AUTH_TOKEN}" ]; then
  echo "Error: TUNNEL_AUTH_TOKEN is empty in ${TOKEN_FILE}"
  exit 1
fi

if ! curl -s -f "http://127.0.0.1:11434/api/tags" > /dev/null; then
  echo "Error: Local Ollama is not reachable on 127.0.0.1:11434. Run 'ollama serve' first."
  exit 1
fi
echo "Local Ollama is reachable."

echo "=== [2/5] Starting Local Gateway (:11435) ==="
# Kill any prior gateway on 11435
pkill -f "ollama-tunnel-gateway.js" || true

GATEWAY_TOKEN="${TUNNEL_AUTH_TOKEN}" GATEWAY_PORT="${GATEWAY_PORT}" node "${REPO_DIR}/scripts/gateway/ollama-tunnel-gateway.js" > /tmp/kanban-gateway.log 2>&1 &
GATEWAY_PID=$!
sleep 1

# Verify gateway with token
VERIFY_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TUNNEL_AUTH_TOKEN}" \
  -d '{"model":"qwen3.6:latest","messages":[{"role":"user","content":"ping"}]}')

if [ "${VERIFY_CODE}" != "200" ]; then
  echo "Error: Local gateway verification failed with HTTP ${VERIFY_CODE}."
  kill "${GATEWAY_PID}" || true
  exit 1
fi
echo "Local gateway verified (HTTP 200 with Bearer auth)."

echo "=== [3/5] Launching Cloudflare Quick Tunnel ==="
pkill -f "cloudflared tunnel --url ${GATEWAY_URL}" || true
pkill -f "cloudflared tunnel --url http://127.0.0.1:11435" || true
rm -f "${TUNNEL_LOG}"

cloudflared tunnel --url "${GATEWAY_URL}" > "${TUNNEL_LOG}" 2>&1 &
CF_PID=$!

echo "Waiting for trycloudflare.com URL..."
TUNNEL_URL=""
for i in {1..30}; do
  if [ -f "${TUNNEL_LOG}" ]; then
    TUNNEL_URL=$(grep -o 'https://[-a-zA-Z0-9]*\.trycloudflare\.com' "${TUNNEL_LOG}" | head -n 1 || true)
    if [ -n "${TUNNEL_URL}" ]; then
      break
    fi
  fi
  sleep 1
done

if [ -z "${TUNNEL_URL}" ]; then
  echo "Error: Could not obtain trycloudflare.com URL from cloudflared."
  cat "${TUNNEL_LOG}"
  kill "${CF_PID}" "${GATEWAY_PID}" || true
  exit 1
fi

echo "Cloudflare Quick Tunnel active: ${TUNNEL_URL}"

echo "=== [4/5] Updating Railway Environment Variables ==="
railway variable set KANBAN_ASK_PROVIDER=ollama KANBAN_ASK_OLLAMA_HOST="${TUNNEL_URL}" KANBAN_ASK_OLLAMA_AUTH_HEADER="${TUNNEL_AUTH_TOKEN}"

echo "=== [5/5] Tunnel and Gateway are Online ==="
echo "=========================================================="
echo " Ollama Tunnel Gateway is running"
echo " Local Gateway : ${GATEWAY_URL}"
echo " Cloudflare URL: ${TUNNEL_URL}"
echo " Railway Host  : https://agent-kanban.riazrahaman.com"
echo " Model Target  : qwen3.6:latest"
echo "=========================================================="

# Cleanup handler on Ctrl+C or kill
cleanup() {
  echo ""
  echo "Stopping tunnel and gateway..."
  kill "${CF_PID}" "${GATEWAY_PID}" 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM

wait "${CF_PID}"
