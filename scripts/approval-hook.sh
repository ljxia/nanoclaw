#!/bin/bash
# Claude Code PreToolUse hook — forwards approval requests to Discord
# via the approval server. Falls through to normal behavior if server is down.

INPUT=$(cat)

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
