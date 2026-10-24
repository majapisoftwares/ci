#!/bin/sh
# Runs the app's preview-removal script (from this checkout) on the preview box.
#   sh remove-preview.sh <box> <script> <pr-number>
# A stopped box has no running previews, so there is nothing to remove.
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
INSTANCE_ID="$(sh "$HERE/box.sh" id "$1")"
if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = None ]; then
  echo "$1 is not running; no preview to remove."
  exit 0
fi
{ printf 'set -- %s\n' "'$3'"; cat "$2"; } | sh "$HERE/ssm-run.sh" "$INSTANCE_ID" 300 "Remove preview pr-$3"
