#!/bin/sh
# Ships the source (no build) to the preview box and runs the app's fast
# preview script there with numa's argument order:
#   <pr> <sha> <public-domain> <app-domain> <secret-arn> <lock-hash> <run-migrations>
# Inputs (env): PR_NUMBER BOX SECRET_PREFIX ARTIFACT_BUCKET FAST_ROOT FAST_SCRIPT
#   PUBLIC_DOMAIN APP_DOMAIN [RUN_MIGRATIONS]
set -eu

HERE="$(cd "$(dirname "$0")" && pwd)"
: "${GITHUB_SHA:?}" "${PR_NUMBER:?}" "${BOX:?}" "${SECRET_PREFIX:?}" "${ARTIFACT_BUCKET:?}"
: "${FAST_ROOT:?}" "${FAST_SCRIPT:?}" "${PUBLIC_DOMAIN:?}" "${APP_DOMAIN:?}"

KEY="fast-preview-sources/pr-${PR_NUMBER}/${GITHUB_SHA}.tgz"
ARCHIVE="${RUNNER_TEMP:-/tmp}/preview-source-${PR_NUMBER}.tgz"
tar --exclude=.git --exclude=.next --exclude=node_modules --exclude=./.majapi-ci -czf "$ARCHIVE" .
aws s3 cp "$ARCHIVE" "s3://${ARTIFACT_BUCKET}/${KEY}" --only-show-errors
trap 'aws s3 rm "s3://${ARTIFACT_BUCKET}/${KEY}" --only-show-errors || true' EXIT
SOURCE_URL="$(aws s3 presign "s3://${ARTIFACT_BUCKET}/${KEY}" --expires-in 900)"

INSTANCE_ID="$(sh "$HERE/box.sh" id "$BOX")"
SECRET_ARN="$(aws secretsmanager list-secrets --filters "Key=name,Values=${SECRET_PREFIX}" \
  --query 'sort_by(SecretList,&CreatedDate)[-1].ARN' --output text)"
if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = None ] || [ -z "$SECRET_ARN" ] || [ "$SECRET_ARN" = None ]; then
  echo "Box ${BOX} or runtime secret ${SECRET_PREFIX}* is unavailable." >&2
  exit 1
fi
LOCK_HASH="$(sha256sum package-lock.json | cut -c1-16)"

sh "$HERE/ssm-run.sh" "$INSTANCE_ID" 180 "Fast preview pr-${PR_NUMBER}" <<REMOTE
set -eu
RELEASE_DIR='${FAST_ROOT}/releases/${GITHUB_SHA}'
rm -rf "\$RELEASE_DIR"
mkdir -p "\$RELEASE_DIR"
curl -fsSL '${SOURCE_URL}' -o '/tmp/preview-${PR_NUMBER}.tgz'
tar -xzf '/tmp/preview-${PR_NUMBER}.tgz' -C "\$RELEASE_DIR"
rm -f '/tmp/preview-${PR_NUMBER}.tgz'
sh "\$RELEASE_DIR/${FAST_SCRIPT}" '${PR_NUMBER}' '${GITHUB_SHA}' '${PUBLIC_DOMAIN}' '${APP_DOMAIN}' '${SECRET_ARN}' '${LOCK_HASH}' '${RUN_MIGRATIONS:-false}'
REMOTE
