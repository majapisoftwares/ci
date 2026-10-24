#!/bin/sh
# Power and lookup for a box (EC2 instance tagged Name=<name>).
#   sh box.sh id <name>            running instance id, or "None"
#   sh box.sh start <name>         start if stopped; wait for SSM
#   sh box.sh stop-if-idle <name>  stop when no open, non-draft same-repo PR remains
# stop-if-idle needs GH_TOKEN and GITHUB_REPOSITORY.
set -eu

ACTION="$1"
NAME="$2"

field() {
  aws ec2 describe-instances \
    --filters "Name=tag:Name,Values=${NAME}" "Name=instance-state-name,Values=$2" \
    --query "Reservations[].Instances[].$1 | [0]" --output text
}

if [ "$ACTION" = id ]; then
  field InstanceId running
  exit 0
fi

INSTANCE_ID="$(field InstanceId pending,running,stopping,stopped)"
if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
  echo "No ${NAME} instance found." >&2
  exit 0
fi
STATE="$(field State.Name pending,running,stopping,stopped)"

case "$ACTION" in
  start)
    if [ "$STATE" = stopping ]; then
      aws ec2 wait instance-stopped --instance-ids "$INSTANCE_ID"
      STATE=stopped
    fi
    if [ "$STATE" = stopped ]; then
      echo "Starting ${NAME} (${INSTANCE_ID})." >&2
      aws ec2 start-instances --instance-ids "$INSTANCE_ID" >/dev/null
    fi
    aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
    # Deploys reach the box through SSM; reboot once if its agent never returns.
    for round in 1 2; do
      for _ in $(seq 1 36); do
        PING="$(aws ssm describe-instance-information \
          --filters "Key=InstanceIds,Values=${INSTANCE_ID}" \
          --query "InstanceInformationList[0].PingStatus" --output text 2>/dev/null || true)"
        if [ "$PING" = Online ]; then
          exit 0
        fi
        sleep 5
      done
      if [ "$round" = 1 ]; then
        echo "${NAME} is not online in SSM; rebooting it." >&2
        aws ec2 reboot-instances --instance-ids "$INSTANCE_ID"
        aws ec2 wait instance-status-ok --instance-ids "$INSTANCE_ID"
      fi
    done
    echo "${NAME} did not come online in SSM." >&2
    exit 1
    ;;
  stop-if-idle)
    if [ "$STATE" != running ] && [ "$STATE" != pending ]; then
      echo "${NAME} is already ${STATE}."
      exit 0
    fi
    OPEN="$(gh api "repos/${GITHUB_REPOSITORY}/pulls?state=open&per_page=100" --paginate \
      --jq "[.[] | select(.draft == false and .head.repo.full_name == \"${GITHUB_REPOSITORY}\")] | length" \
      | awk '{ total += $1 } END { print total + 0 }')"
    if [ "$OPEN" -gt 0 ]; then
      echo "${OPEN} open PR(s) still use previews; keeping ${NAME} running."
      exit 0
    fi
    echo "No open PRs need previews; stopping ${NAME} (${INSTANCE_ID})."
    aws ec2 stop-instances --instance-ids "$INSTANCE_ID" >/dev/null
    ;;
  *)
    echo "Usage: box.sh id|start|stop-if-idle <name>" >&2
    exit 2
    ;;
esac
