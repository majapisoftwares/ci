#!/bin/sh
# Releases a built app to a Majapi Cloud shared host: uploads the release and
# its production dependencies, hands the release to Cloud with this run's
# GitHub OIDC token, and waits until the host's agent reports it live.
# Prints the app URL on the last line. Inputs (env):
#   APP CLOUD_URL ARTIFACT_BUCKET DOMAIN [RELEASE_TIMEOUT_SECONDS]
# Needs `permissions: id-token: write` and AWS credentials for the bucket.
set -eu

: "${GITHUB_SHA:?}" "${APP:?}" "${CLOUD_URL:?}" "${ARTIFACT_BUCKET:?}" "${DOMAIN:?}"
: "${ACTIONS_ID_TOKEN_REQUEST_URL:?id-token: write permission is required}" "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:?}"
CLOUD_URL="${CLOUD_URL%/}"
TIMEOUT="${RELEASE_TIMEOUT_SECONDS:-1200}"
TMP="${RUNNER_TEMP:-/tmp}"

log() { printf '[hosted] %s %s\n' "$(date -u +%H:%M:%S)" "$1" >&2; }
json() { node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));const k=process.argv[1].split(".");let x=v;for(const p of k)x=x?.[p];process.stdout.write(x===undefined||x===null?"":typeof x==="object"?JSON.stringify(x):String(x))' "$1"; }
# A fresh token per call: they expire in minutes and the wait can be longer.
oidc() { curl -fsS -H "Authorization: bearer ${ACTIONS_ID_TOKEN_REQUEST_TOKEN}" "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${CLOUD_URL}" | json value; }

LOCK_HASH="$(sha256sum package-lock.json | cut -c1-16)"
DEPENDENCIES_KEY="compiled-dependencies/${LOCK_HASH}.tgz"
ARTIFACT_KEY="compiled-releases/hosted/${APP}/${GITHUB_SHA}.tgz"

# Production dependencies are shared by every release with the same lockfile.
if ! aws s3api head-object --bucket "$ARTIFACT_BUCKET" --key "$DEPENDENCIES_KEY" >/dev/null 2>&1; then
  log "packing production dependencies"
  npm prune --omit=dev --no-audit --no-fund >&2
  tar -czf "${TMP}/dependencies.tgz" node_modules
  aws s3 cp "${TMP}/dependencies.tgz" "s3://${ARTIFACT_BUCKET}/${DEPENDENCIES_KEY}" --only-show-errors
fi

COMPRESSOR=gzip
command -v pigz >/dev/null 2>&1 && COMPRESSOR="pigz -1"
tar --exclude=.git --exclude=.env --exclude='.env.*' --exclude=./node_modules \
  --exclude=.next/cache --exclude=coverage --exclude=playwright-report \
  --exclude=test-results --exclude=./.majapi-ci \
  --use-compress-program="$COMPRESSOR" -cf "${TMP}/release.tgz" .
log "uploading release ($(du -h "${TMP}/release.tgz" | cut -f1))"
aws s3 cp "${TMP}/release.tgz" "s3://${ARTIFACT_BUCKET}/${ARTIFACT_KEY}" --only-show-errors

BODY="$(printf '{"sha":"%s","artifactKey":"%s","dependenciesKey":"%s","lockHash":"%s"}' "$GITHUB_SHA" "$ARTIFACT_KEY" "$DEPENDENCIES_KEY" "$LOCK_HASH")"
RESPONSE="$(curl -sS -X POST "${CLOUD_URL}/api/v1/apps/${APP}/releases" -H "Authorization: Bearer $(oidc)" -H "Content-Type: application/json" -d "$BODY" -w '\n%{http_code}')"
CODE="$(printf '%s' "$RESPONSE" | tail -n 1)"
RESPONSE="$(printf '%s' "$RESPONSE" | sed '$d')"
if [ "$CODE" != 202 ]; then
  echo "Cloud refused the release (HTTP ${CODE}): $(printf '%s' "$RESPONSE" | json error.message)" >&2
  exit 1
fi
RELEASE="$(printf '%s' "$RESPONSE" | json id)"
log "release ${RELEASE} queued on Cloud"

DEADLINE=$(( $(date +%s) + TIMEOUT ))
STATUS=queued
while [ "$(date +%s)" -lt "$DEADLINE" ]; do
  sleep 10
  CURRENT="$(curl -fsS "${CLOUD_URL}/api/v1/releases/${RELEASE}" -H "Authorization: Bearer $(oidc)" || true)"
  [ -n "$CURRENT" ] || continue
  NEXT="$(printf '%s' "$CURRENT" | json status)"
  [ "$NEXT" = "$STATUS" ] || log "release is ${NEXT}"
  STATUS="$NEXT"
  case "$STATUS" in live | failed) break ;; esac
done
printf '%s' "$CURRENT" | json log | node -e 'for (const line of JSON.parse(require("fs").readFileSync(0,"utf8")||"[]")) console.error("  " + line)'
case "$STATUS" in
  live) ;;
  failed) echo "The host could not install the release." >&2; exit 1 ;;
  *) echo "The release was still ${STATUS} after ${TIMEOUT}s." >&2; exit 1 ;;
esac
printf 'https://%s\n' "$DOMAIN"
