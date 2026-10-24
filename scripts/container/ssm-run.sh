#!/bin/sh
# Runs a shell command on an EC2 instance through SSM and waits for it.
#   sh ssm-run.sh <instance-id> <timeout-seconds> <comment>   (command on stdin)
set -eu

INSTANCE_ID="$1"
TIMEOUT="$2"
COMMENT="$3"
PAYLOAD="${RUNNER_TEMP:-/tmp}/ssm-command-$$.json"

COMMAND="$(cat)" INSTANCE_ID="$INSTANCE_ID" COMMENT="$COMMENT" node -e '
  require("node:fs").writeFileSync(process.argv[1], JSON.stringify({
    Comment: process.env.COMMENT.slice(0, 100),
    DocumentName: "AWS-RunShellScript",
    InstanceIds: [process.env.INSTANCE_ID],
    Parameters: { commands: [process.env.COMMAND], executionTimeout: [String(Number(process.argv[2]) + 60)] },
  }));
' "$PAYLOAD" "$TIMEOUT"

COMMAND_ID="$(aws ssm send-command --cli-input-json "file://${PAYLOAD}" --query Command.CommandId --output text)"
rm -f "$PAYLOAD"

invocation() {
  aws ssm get-command-invocation --command-id "$COMMAND_ID" --instance-id "$INSTANCE_ID" --query "$1" --output text 2>/dev/null || true
}

ELAPSED=0
while :; do
  STATUS="$(invocation Status)"
  case "$STATUS" in
    Success)
      invocation StandardOutputContent
      exit 0
      ;;
    Failed|Cancelled|TimedOut)
      invocation StandardOutputContent
      invocation StandardErrorContent >&2
      echo "${COMMENT}: SSM command ${STATUS}." >&2
      exit 1
      ;;
  esac
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "${COMMENT}: did not finish within ${TIMEOUT}s." >&2
    exit 1
  fi
  sleep 3
  ELAPSED=$((ELAPSED + 3))
done
