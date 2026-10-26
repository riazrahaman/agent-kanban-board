#!/usr/bin/env bash
# Permanent tunnel for Ask-the-Board's local Ollama provider.
#
# WHY: Ask-the-Board runs on Railway, but the strong local model runs on THIS
# machine (Ollama on :11434). Railway must reach it over a public URL.
#
# Two hops, both already in the repo:
#   1. scripts/gateway/ollama-tunnel-gateway.js — the token-verifying reverse
#      proxy listening on 127.0.0.1:11435 (Railway's KANBAN_ASK_OLLAMA_AUTH_
#      HEADER is its only credential; Ollama itself is never exposed publicly).
#   2. a **Cloudflare named tunnel** in front of it. A named tunnel (NOT a
#      quick `trycloudflare.com` tunnel, whose URL dies with the process) runs
#      as a launchd service here: it reconnects on restart, survives reboots,
#      and is managed in the Cloudflare dashboard.
#
# WHY NOT TAILSCALE FUNNEL: Funnel ingress is relayed through Tailscale's DERP
# edges, and the hosted board's vantage point gets edges that reset the TLS
# handshake (ECONNRESET, every retry). Verified working locally, broken from
# Railway — not fixable from inside the app. Cloudflare's edge is anycast and
# has no such relay dependency.
#
# ONE-TIME SETUP (dashboard, ~2 minutes, no CLI login required):
#   1. https://one.dash.cloudflare.com → Networks → Tunnels → Create tunnel →
#      Cloudflared, name it (e.g. "rstudio-ollama").
#   2. Copy the tunnel token it shows (the long eyJ... string).
#   3. In the tunnel's Public Hostname tab, add: hostname
#      `ollama.riazrahaman.com` → service `http://localhost:11435`.
#   4. Hand the token to the operator running this script.
#
# USAGE:  sudo ./scripts/start-ollama-cloudflare-tunnel.sh <TUNNEL_TOKEN>
# (root is required to install the launchd service; it starts on boot and
# restarts itself — that is what makes the tunnel permanent.)

set -euo pipefail

TOKEN_INPUT="${1:-}"
if [[ -z "$TOKEN_INPUT" ]]; then
  echo "usage: sudo $0 <CLOUDFLARE_TUNNEL_TOKEN>" >&2
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared not found: brew install cloudflared" >&2
  exit 1
fi

if ! curl -fsS -o /dev/null -m 3 http://127.0.0.1:11435/; then
  echo "WARN: the gateway on 127.0.0.1:11435 is not responding — start it" >&2
  echo "      (node scripts/gateway/ollama-tunnel-gateway.js) so the tunnel has a target." >&2
fi

# The service install writes the token into the launchd plist (root-owned,
# 0644 by default → contains a secret, so tighten it).
cloudflared service install "$TOKEN_INPUT"
PLIST="/Library/LaunchDaemons/com.cloudflare.cloudflared.plist"
if [[ -f "$PLIST" ]]; then
  chown root:wheel "$PLIST" && chmod 0640 "$PLIST"
fi

launchctl kickstart -k system/com.cloudflare.cloudflared 2>/dev/null || true
sleep 3

echo
echo "Installed. Verify:"
echo "  launchctl list | grep cloudflared"
echo "  curl -I https://<your-tunnel-hostname>/   (401 = gateway reachable & gated)"
echo
echo "Then point the board at it (Railway, service agent-kanban-board):"
echo "  KANBAN_ASK_PROVIDER=ollama"
echo "  KANBAN_ASK_OLLAMA_HOST=https://<your-tunnel-hostname>"
echo "  KANBAN_ASK_OLLAMA_AUTH_HEADER=<the gateway secret — already configured>"