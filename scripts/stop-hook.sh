#!/bin/bash
# Claude Code Stop hook — forwards stop decisions to Discord approval server.
# User can continue (with optional instructions), or let the session stop.
# Falls through to normal behavior if server is down.
# Skips Discord routing if user is active at the computer (idle < 5 min).

INPUT=$(cat)

# Check system idle time — if user is active, let session stop normally
IDLE_THRESHOLD_MS=300000  # 5 minutes
IDLE_MS=$(dbus-send --print-reply --dest=org.gnome.Mutter.IdleMonitor \
  /org/gnome/Mutter/IdleMonitor/Core org.gnome.Mutter.IdleMonitor.GetIdletime \
  2>/dev/null | grep uint64 | awk '{print $2}')
if [ -n "$IDLE_MS" ] && [ "$IDLE_MS" -lt "$IDLE_THRESHOLD_MS" ] 2>/dev/null; then
  exit 0  # User is active — let Claude stop normally
fi

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
