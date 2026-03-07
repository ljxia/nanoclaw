#!/bin/bash
# Claude Code Stop hook — blocks stop and forces AskUserQuestion
# so Discord-approved sessions stay alive for continued interaction.

INPUT=$(cat)
CWD=$(echo "$INPUT" | jq -r '.cwd // ""')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""')
SUMMARY=$(echo "$INPUT" | jq -r '.last_assistant_message // ""')

# Notify Discord that the session is about to stop
curl -sf --max-time 5 -X POST \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg s "$SUMMARY" --arg cwd "$CWD" --arg sid "$SESSION_ID" \
    '{summary: $s, cwd: $cwd, session_id: $sid}')" \
  http://127.0.0.1:7711/notify 2>/dev/null

# Block the stop and inject context so AskUserQuestion includes what was done
REASON=$(jq -n --arg summary "$SUMMARY" --arg cwd "$CWD" '
  "Do not stop yet. You just finished working in " + $cwd + ". Here is a summary of what you did:\n\n" + $summary + "\n\nUse the AskUserQuestion tool to ask the user what they would like to do next. Include a brief recap of what was completed and any noteworthy results (test outcomes, errors, files changed) in your question so the user has full context to decide."
' -r)

jq -n --arg reason "$REASON" '{
  "decision": "block",
  "reason": $reason
}'
