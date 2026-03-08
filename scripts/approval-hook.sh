#!/bin/bash
# Claude Code PreToolUse hook — forwards approval requests to Discord
# via the approval server. Falls through to normal behavior if server is down.
# Skips Discord routing if user is active at the computer (idle < 5 min).

INPUT=$(cat)

# Check system idle time — if user is active, let them approve in terminal
IDLE_THRESHOLD_MS=60000  # 1 minute
IDLE_MS=$(dbus-send --print-reply --dest=org.gnome.Mutter.IdleMonitor \
  /org/gnome/Mutter/IdleMonitor/Core org.gnome.Mutter.IdleMonitor.GetIdletime \
  2>/dev/null | grep uint64 | awk '{print $2}')
if [ -n "$IDLE_MS" ] && [ "$IDLE_MS" -lt "$IDLE_THRESHOLD_MS" ] 2>/dev/null; then
  exit 0  # User is active — fall through to terminal prompt
fi

# Show waiting message in Claude Code terminal (stderr shows as hook feedback)
echo "⏳ Waiting for Discord approval..." >&2

RESPONSE=$(echo "$INPUT" | curl -sf --max-time 660 -X POST \
  -H 'Content-Type: application/json' \
  -d @- http://127.0.0.1:7711/request 2>/dev/null)

if [ $? -ne 0 ] || [ -z "$RESPONSE" ]; then
  # Server unreachable — fall through to normal Claude Code permission prompt
  exit 0
fi

# Show result in Claude Code terminal
DECISION=$(echo "$RESPONSE" | jq -r '.hookSpecificOutput.permissionDecision // "unknown"')
REASON=$(echo "$RESPONSE" | jq -r '.hookSpecificOutput.permissionDecisionReason // ""')
if [ "$DECISION" = "allow" ]; then
  echo "✅ $REASON" >&2
else
  echo "❌ $REASON" >&2
fi

echo "$RESPONSE"
exit 0
