#!/bin/bash
# Claude Code Stop hook — forwards stop decisions to Discord approval server.
# User can continue (with optional instructions), or let the session stop.
# Falls through to normal behavior if server is down.

INPUT=$(cat)

# Break infinite loops: if we already blocked a stop, let this one through
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false')
if [ "$STOP_ACTIVE" = "true" ]; then
  # Notify Discord that session stopped (fire-and-forget)
  echo "$INPUT" | curl -sf --max-time 5 -X POST \
    -H 'Content-Type: application/json' \
    -d @- http://127.0.0.1:7711/notify 2>/dev/null
  exit 0
fi

echo "⏸️ Waiting for Discord decision..." >&2

RESPONSE=$(echo "$INPUT" | curl -sf --max-time 660 -X POST \
  -H 'Content-Type: application/json' \
  -d @- http://127.0.0.1:7711/stop 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  # Server unreachable — let Claude stop normally
  exit 0
fi

DECISION=$(echo "$RESPONSE" | jq -r '.decision // ""')
if [ "$DECISION" = "block" ]; then
  REASON=$(echo "$RESPONSE" | jq -r '.reason // "User wants to continue"')
  echo "▶️ $REASON" >&2
  echo "$RESPONSE"
else
  echo "⏹️ Stopping" >&2
fi

exit 0
