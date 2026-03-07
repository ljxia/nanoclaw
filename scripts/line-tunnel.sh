#!/bin/bash
# Start a cloudflared quick tunnel for LINE webhook and auto-register the URL.
# Quick tunnels get a random *.trycloudflare.com URL on each start.
# This script captures the URL and sets it as the LINE webhook endpoint.

PORT="${LINE_WEBHOOK_PORT:-3100}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/../.env"

# Read LINE_CHANNEL_ACCESS_TOKEN from .env if not set
if [ -z "${LINE_CHANNEL_ACCESS_TOKEN:-}" ] && [ -f "$ENV_FILE" ]; then
  eval "$(grep '^LINE_CHANNEL_ACCESS_TOKEN=' "$ENV_FILE")"
  export LINE_CHANNEL_ACCESS_TOKEN
fi

if [ -z "${LINE_CHANNEL_ACCESS_TOKEN:-}" ]; then
  echo "ERROR: LINE_CHANNEL_ACCESS_TOKEN not set" >&2
  exit 1
fi

register_webhook() {
  local webhook_url="$1/webhook"
  echo "Registering LINE webhook: ${webhook_url}"

  # Wait until the tunnel is publicly reachable
  for i in $(seq 1 15); do
    if curl -sf -o /dev/null --max-time 5 -X POST "$webhook_url" 2>/dev/null; then
      echo "Tunnel is reachable"
      break
    fi
    # 401 also means reachable (signature validation failed = our server replied)
    local code
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 -X POST "$webhook_url" 2>/dev/null) || true
    if [ "$code" = "401" ] || [ "$code" = "200" ] || [ "$code" = "404" ]; then
      echo "Tunnel is reachable (HTTP $code)"
      break
    fi
    echo "Waiting for tunnel to become reachable... (attempt $i)"
    sleep 2
  done

  local body
  body=$(printf '{"endpoint":"%s"}' "$webhook_url")

  local result
  result=$(curl -s -w "\n%{http_code}" -X PUT \
    -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body" \
    https://api.line.me/v2/bot/channel/webhook/endpoint 2>/dev/null) || true

  local http_code
  http_code=$(echo "$result" | tail -1)

  if [ "$http_code" = "200" ]; then
    echo "LINE webhook registered successfully"
  else
    echo "Failed to register LINE webhook (HTTP ${http_code})" >&2
    echo "$result" | head -1 >&2
    # Retry once after a delay
    sleep 5
    echo "Retrying..."
    result=$(curl -s -w "\n%{http_code}" -X PUT \
      -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
      -H "Content-Type: application/json" \
      -d "$body" \
      https://api.line.me/v2/bot/channel/webhook/endpoint 2>/dev/null) || true
    http_code=$(echo "$result" | tail -1)
    if [ "$http_code" = "200" ]; then
      echo "LINE webhook registered successfully (retry)"
    else
      echo "Failed to register LINE webhook on retry (HTTP ${http_code})" >&2
    fi
  fi
}

# Start cloudflared quick tunnel in background and capture URL from stderr
TUNNEL_LOG=$(mktemp)
cloudflared tunnel --no-autoupdate --url "http://localhost:${PORT}" 2>"$TUNNEL_LOG" &
TUNNEL_PID=$!

# Ensure cleanup on exit
trap 'kill $TUNNEL_PID 2>/dev/null; rm -f "$TUNNEL_LOG"' EXIT

# Wait for the tunnel URL to appear in logs
echo "Waiting for tunnel URL..."
TUNNEL_URL=""
for i in $(seq 1 30); do
  TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)
  if [ -n "$TUNNEL_URL" ]; then
    break
  fi
  sleep 1
done

if [ -z "$TUNNEL_URL" ]; then
  echo "ERROR: Failed to get tunnel URL after 30s" >&2
  cat "$TUNNEL_LOG" >&2
  exit 1
fi

echo "Tunnel URL: ${TUNNEL_URL}"
register_webhook "$TUNNEL_URL"

# Wait for tunnel process (keeps service running)
wait $TUNNEL_PID
