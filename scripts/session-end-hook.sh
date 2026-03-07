#!/bin/bash
# Claude Code SessionEnd hook — notifies Discord when a session ends.
# Catches exits that the Stop hook misses (user interrupts, plan mode exits, etc.)

INPUT=$(cat)

# Fire-and-forget notification to Discord
echo "$INPUT" | curl -sf --max-time 5 -X POST \
  -H 'Content-Type: application/json' \
  -d @- http://127.0.0.1:7711/notify 2>/dev/null

exit 0
