#!/bin/sh
# Pulumi S3 backend helpers.
#   sh pulumi-state.sh exists <bucket> <stack>           prints true/false
#   sh pulumi-state.sh outputs <bucket> <stack>          prints true when the stack has outputs
#   sh pulumi-state.sh clear-lock <bucket> <project> <stack>
# clear-lock waits up to two minutes for a running update, then removes locks
# left behind by canceled runs.
set -eu

case "$1" in
  exists)
    KEYS="$(aws s3api list-objects-v2 --bucket "$2" --prefix ".pulumi/stacks/" --query "Contents[].Key" --output text)"
    if printf '%s\n' "$KEYS" | tr '\t' '\n' | grep -Eq "(^|/)$3\.json$"; then echo true; else echo false; fi
    ;;
  outputs)
    # A failed update can leave a stack without outputs, which breaks every
    # stack that references it; callers treat that as not provisioned.
    KEYS="$(aws s3api list-objects-v2 --bucket "$2" --prefix ".pulumi/stacks/" --query "Contents[].Key" --output text)"
    KEY="$(printf '%s\n' "$KEYS" | tr '\t' '\n' | grep -E "(^|/)$3\.json$" | head -n 1)"
    if [ -n "$KEY" ] && aws s3 cp --quiet "s3://$2/$KEY" - | jq -e '[.checkpoint.latest.resources[]? | select(.type == "pulumi:pulumi:Stack") | (.outputs // {}) | length] | add // 0 | . > 0' >/dev/null; then echo true; else echo false; fi
    ;;
  clear-lock)
    PREFIX=".pulumi/locks/organization/$3/$4/"
    for attempt in $(seq 1 12); do
      LOCKS="$(aws s3api list-objects-v2 --bucket "$2" --prefix "$PREFIX" --query "Contents[].Key" --output text)"
      if [ -z "$LOCKS" ] || [ "$LOCKS" = None ]; then
        exit 0
      fi
      [ "$attempt" = 12 ] || sleep 10
    done
    for key in $(printf '%s\n' "$LOCKS" | tr '\t' '\n'); do
      echo "Deleting canceled Pulumi lock ${key}"
      aws s3api delete-object --bucket "$2" --key "$key"
    done
    ;;
  *)
    echo "Usage: pulumi-state.sh exists|outputs|clear-lock ..." >&2
    exit 2
    ;;
esac
