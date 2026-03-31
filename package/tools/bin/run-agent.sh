#!/usr/bin/env bash
# run-agent.sh — Launch a Copilot agent with run tracking and transcript logging.
#
# Usage:
#   migration/bin/run-agent.sh <agent> [model] [prompt]
#
# Examples:
#   migration/bin/run-agent.sh context-agent gpt-5-mini "Run inventory on legacy/"
#   migration/bin/run-agent.sh migration-agent gpt-5-mini "Migrate next task"
#   migration/bin/run-agent.sh planner-agent claude-sonnet-4.6 "Run planning"
#
# What it does:
#   1. Creates a timestamped log file in logs/
#   2. Records the run start in the registry (agent, model, log file path)
#   3. Launches copilot --agent, tees all output to the log file
#   4. Records the run finish with exit code
#
# The registry CLI must already be built:
#   cd migration && npm install && npm run build && cd ..

set -euo pipefail

AGENT="${1:?Usage: run-agent.sh <agent> [model] [prompt]}"
MODEL="${2:-gpt-5-mini}"
PROMPT="${3:-}"
REGISTRY="node migration/registry/dist/cli.js"
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_DIR="logs"
LOG_FILE="${LOG_DIR}/${AGENT}-${TIMESTAMP}.log"

mkdir -p "$LOG_DIR"

# Record run start
RUN_ID=$(
  $REGISTRY start-run \
    --agent "$AGENT" \
    --model "$MODEL" \
    ${PROMPT:+--prompt "$PROMPT"} \
    --log-file "$LOG_FILE" \
  | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8');console.log(JSON.parse(d).run_id)"
)

echo "▶ Run started: $RUN_ID"
echo "  Agent:    $AGENT"
echo "  Model:    $MODEL"
echo "  Log:      $LOG_FILE"
echo ""

# Launch agent, tee to log
EXIT_CODE=0
if [ -n "$PROMPT" ]; then
  copilot --agent "$AGENT" --model "$MODEL" --yolo -p "$PROMPT" 2>&1 | tee "$LOG_FILE" || EXIT_CODE=${PIPESTATUS[0]}
else
  copilot --agent "$AGENT" --model "$MODEL" --yolo 2>&1 | tee "$LOG_FILE" || EXIT_CODE=${PIPESTATUS[0]}
fi

# Record run finish
$REGISTRY finish-run --run-id "$RUN_ID" --exit-code "$EXIT_CODE" > /dev/null

STATUS="completed"
[ "$EXIT_CODE" -ne 0 ] && STATUS="failed"

echo ""
echo "■ Run finished: $RUN_ID ($STATUS, exit $EXIT_CODE)"
echo "  Transcript: $LOG_FILE"
