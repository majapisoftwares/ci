#!/bin/sh
# Packs the built app, uploads it and runs the app's deploy script on its box.
# Prints the primary URL on the last line. Inputs (env):
#   ENVIRONMENT_NAME DOMAINS BOX SECRET_PREFIX ARTIFACT_BUCKET APP_ROOT
#   DEPLOY_SCRIPT RUNTIME_HASH_FILE [RUN_MIGRATIONS CPU MEMORY APP_DOMAIN PUBLIC_DOMAIN]
# The deploy script runs from the extracted release with numa's argument order:
#   <env> <sha> <domains> <secret-arn> <lock-hash> <runtime-hash> <deps-url>
#   <run-migrations> <cpu> <memory> <app-domain> <public-domain>
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
: "${GITHUB_SHA:?}" "${ENVIRONMENT_NAME:?}" "${DOMAINS:?}" "${BOX:?}" "${SECRET_PREFIX:?}"
: "${ARTIFACT_BUCKET:?}" "${APP_ROOT:?}" "${DEPLOY_SCRIPT:?}" "${RUNTIME_HASH_FILE:?}"
RUN_MIGRATIONS="${RUN_MIGRATIONS:-false}"
TMP="${RUNNER_TEMP:-/tmp}"

log() { printf '[release] %s %s\n' "$(date -u +%H:%M:%S)" "$1" >&2; }

LOCK_HASH="$(sha256sum package-lock.json | cut -c1-16)"
RUNTIME_HASH="$(sha256sum "$RUNTIME_HASH_FILE" | cut -c1-16)"
DEPENDENCIES_KEY="compiled-dependencies/${LOCK_HASH}.tgz"
ARTIFACT_KEY="compiled-releases/${ENVIRONMENT_NAME}/${GITHUB_SHA}.tgz"

# Production dependencies are shared by every release with the same lockfile.
if ! aws s3api head-object --bucket "$ARTIFACT_BUCKET" --key "$DEPENDENCIES_KEY" >/dev/null 2>&1; then
  log "pruning dev dependencies for runtime packaging"
  npm prune --omit=dev --no-audit --no-fund >&2
  tar -czf "${TMP}/dependencies.tgz" node_modules
  aws s3 cp "${TMP}/dependencies.tgz" "s3://${ARTIFACT_BUCKET}/${DEPENDENCIES_KEY}" --only-show-errors
fi
DEPENDENCIES_URL="$(aws s3 presign "s3://${ARTIFACT_BUCKET}/${DEPENDENCIES_KEY}" --expires-in 1800)"

COMPRESSOR=gzip
command -v pigz >/dev/null 2>&1 && COMPRESSOR="pigz -1"
log "packing release with ${COMPRESSOR}"
tar --exclude=.git --exclude=.env --exclude='.env.*' --exclude=./node_modules \
  --exclude=.next/cache --exclude=coverage --exclude=playwright-report \
  --exclude=test-results --exclude=./.majapi-ci \
  --use-compress-program="$COMPRESSOR" -cf "${TMP}/release.tgz" .
log "uploading release ($(du -h "${TMP}/release.tgz" | cut -f1))"
aws s3 cp "${TMP}/release.tgz" "s3://${ARTIFACT_BUCKET}/${ARTIFACT_KEY}" --only-show-errors
ARTIFACT_URL="$(aws s3 presign "s3://${ARTIFACT_BUCKET}/${ARTIFACT_KEY}" --expires-in 1800)"

INSTANCE_ID="$(sh "$HERE/box.sh" id "$BOX")"
SECRET_ARN="$(aws secretsmanager list-secrets --filters "Key=name,Values=${SECRET_PREFIX}" \
  --query 'sort_by(SecretList,&CreatedDate)[-1].ARN' --output text)"
if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = None ] || [ -z "$SECRET_ARN" ] || [ "$SECRET_ARN" = None ]; then
  echo "Box ${BOX} or runtime secret ${SECRET_PREFIX}* is unavailable." >&2
  exit 1
fi

log "deploying on ${BOX} (${INSTANCE_ID})"
sh "$HERE/ssm-run.sh" "$INSTANCE_ID" 360 "Deploy ${ENVIRONMENT_NAME} ${GITHUB_SHA}" >&2 <<REMOTE
set -eu
RELEASE_DIR='${APP_ROOT}/releases/${GITHUB_SHA}'
rm -rf "\$RELEASE_DIR"
mkdir -p "\$RELEASE_DIR"
curl -fsSL '${ARTIFACT_URL}' -o '/tmp/release-${ENVIRONMENT_NAME}.tgz'
tar -xzf '/tmp/release-${ENVIRONMENT_NAME}.tgz' -C "\$RELEASE_DIR"
rm -f '/tmp/release-${ENVIRONMENT_NAME}.tgz'
sh "\$RELEASE_DIR/${DEPLOY_SCRIPT}" '${ENVIRONMENT_NAME}' '${GITHUB_SHA}' '${DOMAINS}' '${SECRET_ARN}' '${LOCK_HASH}' '${RUNTIME_HASH}' '${DEPENDENCIES_URL}' '${RUN_MIGRATIONS}' '${CPU:-1.25}' '${MEMORY:-1536m}' '${APP_DOMAIN:-}' '${PUBLIC_DOMAIN:-}'
REMOTE
log "release promoted"

aws s3 rm "s3://${ARTIFACT_BUCKET}/${ARTIFACT_KEY}" --only-show-errors || true
printf 'https://%s\n' "$(printf '%s' "${DOMAINS%%,*}" | tr -d ' ')"
