#!/usr/bin/env bash
# scripts/setup-ollama-persistent-tunnel.sh
#
# Sets up a permanent, persistent link between the Railway Kanban Board
# and your local Ollama instance via Tailscale Funnel + Local Token Gateway.
#
# Unlike Quick Tunnels, this gives a permanent domain (https://rstudio.taile9308c.ts.net)
# that never changes, does not require keeping a terminal window open, and does not
# expose your private tailnet/network to Railway.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
TOKEN_FILE="${HOME}/.agent-grid/ollama-tunnel-token.env"
PLIST_FILE="${HOME}/Library/LaunchAgents/com.riazrahaman.ollama-tunnel-gateway.plist"
LOG_DIR="${HOME}/.agent-grid"
GATEWAY_PORT=11435
GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}"
NODE_BIN="$(which node || echo "/opt/homebrew/bin/node")"

mkdir -p "${LOG_DIR}"

echo "=== [1/4] Verifying Ollama & Auth Token ==="
if [ ! -f "${TOKEN_FILE}" ]; then
  RANDOM_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
  echo "TUNNEL_AUTH_TOKEN=\"${RANDOM_TOKEN}\"" > "${TOKEN_FILE}"
  chmod 600 "${TOKEN_FILE}"
fi

TUNNEL_AUTH_TOKEN=$(grep '^TUNNEL_AUTH_TOKEN=' "${TOKEN_FILE}" | cut -d= -f2- | tr -d '"\r\n')

if ! curl -s -f "http://127.0.0.1:11434/api/tags" > /dev/null; then
  echo "Error: Local Ollama is not reachable on 127.0.0.1:11434. Please start Ollama."
  exit 1
fi
echo "✓ Local Ollama is reachable."

echo "=== [2/4] Installing Local Gateway as a Background LaunchAgent Service ==="
cat <<EOF > "${PLIST_FILE}"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.riazrahaman.ollama-tunnel-gateway</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>${REPO_DIR}/scripts/gateway/ollama-tunnel-gateway.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/ollama-gateway.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/ollama-gateway.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>GATEWAY_PORT</key>
        <string>${GATEWAY_PORT}</string>
        <key>GATEWAY_TOKEN</key>
        <string>${TUNNEL_AUTH_TOKEN}</string>
        <key>OLLAMA_TARGET</key>
        <string>http://127.0.0.1:11434</string>
    </dict>
</dict>
</plist>
EOF

# Unload previous service if loaded, then load fresh
launchctl unload "${PLIST_FILE}" 2>/dev/null || true
launchctl load -w "${PLIST_FILE}"
sleep 1

# Verify gateway is responding
VERIFY_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${GATEWAY_URL}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TUNNEL_AUTH_TOKEN}" \
  -d '{"model":"qwen3.6:latest","messages":[{"role":"user","content":"ping"}],"max_tokens":1}')

if [ "${VERIFY_CODE}" != "200" ]; then
  echo "Error: Gateway verification failed with HTTP ${VERIFY_CODE}."
  echo "Check log: cat ${LOG_DIR}/ollama-gateway.log"
  exit 1
fi
echo "✓ Gateway background service active on port ${GATEWAY_PORT}."

echo "=== [3/4] Enabling Tailscale Funnel on Port ${GATEWAY_PORT} ==="
FUNNEL_OUTPUT=$(tailscale funnel --yes --bg ${GATEWAY_PORT} 2>&1 || true)

if echo "${FUNNEL_OUTPUT}" | grep -q "login.tailscale.com"; then
  echo ""
  echo "************************************************************************"
  echo "ACTION REQUIRED: Funnel needs one-time activation on your Tailnet."
  echo "Please open this link in your browser and click 'Enable Funnel':"
  echo ""
  echo "  https://login.tailscale.com/f/funnel?node=nmUEH2BA2421CNTRL"
  echo ""
  echo "After enabling it in your browser, run this script again."
  echo "************************************************************************"
  exit 2
fi

echo "✓ Tailscale Funnel enabled."
tailscale funnel status

echo "=== [4/4] Configuring Railway Production Environment ==="
STATIC_HOST="https://rstudio.taile9308c.ts.net"
railway variable set \
  KANBAN_ASK_PROVIDER="ollama" \
  KANBAN_ASK_OLLAMA_HOST="${STATIC_HOST}" \
  KANBAN_ASK_OLLAMA_AUTH_HEADER="${TUNNEL_AUTH_TOKEN}" \
  KANBAN_ASK_MODEL="qwen3.6:latest" \
  KANBAN_ASK_TIMEOUT_MS="180000"

echo ""
echo "=========================================================="
echo " Permanent Ollama Tunnel Setup Complete!"
echo " Public Static URL: ${STATIC_HOST}"
echo " Local Gateway    : ${GATEWAY_URL} (managed via launchd)"
echo " Railway Host     : https://agent-kanban.riazrahaman.com"
echo " Model            : qwen3.6:latest"
echo "=========================================================="
