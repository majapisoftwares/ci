#!/bin/sh
# Promotes a release on a box-app box (runs there as root through SSM, from the
# extracted release). Arguments follow scripts/container/publish-release.sh:
#   <env> <sha> <domains> <secret-arn> <lock-hash> <runtime-hash> <deps-url>
#   <run-migrations> <cpu> <memory> <app-domain> <public-domain>
# The app runs `npm start` as the `app` user on 127.0.0.1:3000 behind Caddy.
set -eu

GIT_SHA="$2"
DOMAINS="$3"
SECRET_ARN="$4"
LOCK_HASH="$5"
DEPS_URL="$7"
RELEASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_ROOT="$(dirname "$(dirname "$RELEASE_DIR")")"
PORT=3000

log() { printf '[box-app] %s\n' "$1"; }

# Production dependencies are shared by releases with the same lockfile.
DEPS_DIR="${APP_ROOT}/deps/${LOCK_HASH}"
if [ ! -f "${DEPS_DIR}/.installed" ]; then
  log "installing dependencies ${LOCK_HASH}"
  rm -rf "$DEPS_DIR" && mkdir -p "$DEPS_DIR"
  if [ "$DEPS_URL" = - ]; then
    # Installed here so native packages match this box's CPU and libc. Only
    # dependencies' install scripts run, not the app's own lifecycle scripts.
    cp "${RELEASE_DIR}/package.json" "${RELEASE_DIR}/package-lock.json" "$DEPS_DIR/"
    # SSM children inherit its OOM protection. Let the kernel kill an installer
    # before it kills the running app, HTTPS proxy or system services.
    (echo 500 > /proc/self/oom_score_adj
      cd "$DEPS_DIR"
      HOME=/tmp npm ci --omit=dev --ignore-scripts --no-audit --no-fund
      HOME=/tmp npm rebuild)
  else
    curl -fsSL "$DEPS_URL" | tar -xz -C "$DEPS_DIR"
  fi
  touch "${DEPS_DIR}/.installed"
fi
rm -rf "${RELEASE_DIR}/node_modules"
ln -s "${DEPS_DIR}/node_modules" "${RELEASE_DIR}/node_modules"

# Runtime env: the secret holds dotenv text.
aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text > "${APP_ROOT}/runtime.env.new"
printf '\nNODE_ENV=production\nPORT=%s\nHOSTNAME=127.0.0.1\nDEPLOYMENT_SHA=%s\n' "$PORT" "$GIT_SHA" >> "${APP_ROOT}/runtime.env.new"
chmod 600 "${APP_ROOT}/runtime.env.new"
mv "${APP_ROOT}/runtime.env.new" "${APP_ROOT}/runtime.env"

cat > /etc/systemd/system/app.service <<UNIT
[Unit]
Description=App (box-app)
After=network-online.target
[Service]
User=app
WorkingDirectory=${APP_ROOT}/current
EnvironmentFile=${APP_ROOT}/runtime.env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/local/bin/npm start
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT

PREVIOUS="$(readlink "${APP_ROOT}/current" 2>/dev/null || true)"
chown -R app:app "$RELEASE_DIR"
ln -sfn "$RELEASE_DIR" "${APP_ROOT}/current"
systemctl daemon-reload
systemctl enable app >/dev/null 2>&1
systemctl restart app

healthy=false
for _ in $(seq 1 60); do
  CODE="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" || true)"
  case "$CODE" in [234]??) healthy=true; break ;; esac
  sleep 2
done
if [ "$healthy" != true ]; then
  journalctl -u app -n 50 --no-pager || true
  if [ -n "$PREVIOUS" ]; then
    log "release ${GIT_SHA} did not start; rolling back to ${PREVIOUS}"
    ln -sfn "$PREVIOUS" "${APP_ROOT}/current"
    systemctl restart app
  fi
  exit 1
fi

SITES=""
for domain in $(printf '%s' "$DOMAINS" | tr ',' ' '); do SITES="${SITES:+$SITES, }$domain"; done
printf '%s {\n  encode zstd gzip\n  reverse_proxy 127.0.0.1:%s\n}\n' "$SITES" "$PORT" > /etc/caddy/sites/app.caddy
rm -f /etc/caddy/sites/default.caddy
/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile
systemctl reset-failed caddy
systemctl reload-or-restart caddy

# Keep the three newest releases and their dependency sets.
find "${APP_ROOT}/releases" -mindepth 1 -maxdepth 1 -printf '%T@ %p\n' | sort -rn | tail -n +4 | cut -d' ' -f2- | xargs -r rm -rf
for deps in "${APP_ROOT}"/deps/*; do
  find "${APP_ROOT}/releases" -maxdepth 2 -lname "${deps}/node_modules" | grep -q . || rm -rf "$deps"
done
log "release ${GIT_SHA} is live"
