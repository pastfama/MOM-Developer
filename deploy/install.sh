#!/usr/bin/env bash
# Install or upgrade the Dev Agent on a prod box.
#
#   sudo ./deploy/install.sh                 # install/upgrade from this checkout
#   sudo ./deploy/install.sh --prefix /srv/dev-agent
#
# Layout (releases are immutable, data lives outside them):
#   $PREFIX/releases/<utc-stamp>/   this version
#   $PREFIX/current -> releases/...  the running version
#   $PREFIX/shared/.data/sessions/   conversations, untouched by deploys
#
# Safe to re-run. Health check failure rolls back to the previous release.
set -euo pipefail

PREFIX="${PREFIX:-/opt/dev-agent}"
SERVICE_NAME="dev-agent"
SERVICE_USER="${SERVICE_USER:-devagent}"
ENV_FILE="${ENV_FILE:-/etc/dev-agent.env}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
NODE_BIN="${NODE_BIN:-$(command -v node || echo /usr/bin/node)}"
SOURCE=""
USE_SYSTEMD=1
DO_HEALTH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --no-systemd) USE_SYSTEMD=0; shift ;;
    --skip-health) DO_HEALTH=0; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE="${SOURCE:-$(cd "$SCRIPT_DIR/.." && pwd)}"

log() { printf '==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[[ -f "$SOURCE/server.js" ]] || die "$SOURCE does not look like the repo (no server.js)"
command -v "$NODE_BIN" >/dev/null 2>&1 || die "node not found; set NODE_BIN=/path/to/node"
[[ -f "$SCRIPT_DIR/dev-agent.service" ]] || die "missing dev-agent.service next to this script"

RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)"
[[ -e "$PREFIX/releases/$RELEASE_ID" ]] && RELEASE_ID="$RELEASE_ID-$$"
RELEASE_DIR="$PREFIX/releases/$RELEASE_ID"
DATA_DIR="${DATA_DIR:-$PREFIX/shared/.data}"

log "source:  $SOURCE"
log "release: $RELEASE_DIR"
log "data:    $DATA_DIR (persists across deploys)"

if [[ $USE_SYSTEMD -eq 1 && $(id -u) -ne 0 ]]; then
  die "systemd install needs root; re-run with sudo or pass --no-systemd"
fi

# ── service user ──
if [[ $USE_SYSTEMD -eq 1 ]] && ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  log "creating system user $SERVICE_USER"
  useradd --system --home "$PREFIX" --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null \
    || useradd --system --home "$PREFIX" --shell /bin/false "$SERVICE_USER"
fi

# ── stage the release ──
install -d -m 0755 "$PREFIX" "$PREFIX/releases" "$RELEASE_DIR" "$DATA_DIR"
for item in server.js package.json package-lock.json vite.config.mjs lib dev-portal README.md; do
  [[ -e "$SOURCE/$item" ]] || die "missing $item in $SOURCE"
  cp -a "$SOURCE/$item" "$RELEASE_DIR/"
done

# No runtime dependencies, but stay honest if they are ever added.
if [[ -f "$RELEASE_DIR/package.json" ]] && grep -Eq '"(dependencies|devDependencies)"' "$RELEASE_DIR/package.json"; then
  log "installing build dependencies"
  (
    cd "$RELEASE_DIR"
    npm ci --silent
    npm run build --silent
    npm prune --omit=dev --silent
  ) || die "frontend build failed"
fi

if [[ $USE_SYSTEMD -eq 1 ]]; then
  chown -R "$SERVICE_USER":"$SERVICE_USER" "$PREFIX"
fi

# ── env file ──
if [[ ! -f "$ENV_FILE" ]]; then
  install -m 0600 "$SCRIPT_DIR/dev-agent.env.example" "$ENV_FILE"
  log "created $ENV_FILE — review it (no secrets are set yet)"
fi

# ── flip the symlink ──
PREVIOUS=""
if [[ -L "$PREFIX/current" ]]; then PREVIOUS="$(readlink -f "$PREFIX/current")"; fi
ln -sfn "$RELEASE_DIR" "$PREFIX/current"
log "current -> $(readlink -f "$PREFIX/current")"

# ── (re)start ──
if [[ $USE_SYSTEMD -eq 1 ]]; then
  sed -e "s|__PREFIX__|$PREFIX|g" \
      -e "s|__USER__|$SERVICE_USER|g" \
      -e "s|__NODE_BIN__|$NODE_BIN|g" \
      -e "s|__ENV_FILE__|$ENV_FILE|g" \
      "$SCRIPT_DIR/dev-agent.service" > "/etc/systemd/system/$SERVICE_NAME.service"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
  log "restarting $SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
else
  log "--no-systemd: start it yourself, e.g."
  log "  DATA_DIR=$DATA_DIR PORT=3000 node $PREFIX/current/server.js"
fi

# ── health check ──
PORT_VALUE="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"' || true)"
PORT_VALUE="${PORT_VALUE:-3000}"
HEALTH_URL="http://127.0.0.1:$PORT_VALUE/api/health"

if [[ $DO_HEALTH -eq 1 ]]; then
  log "health check: $HEALTH_URL"
  HEALTHY=0
  for _ in $(seq 1 20); do
    if curl -fsS --max-time 2 "$HEALTH_URL" 2>/dev/null | grep -q '"ok":true'; then HEALTHY=1; break; fi
    sleep 0.5
  done

  if [[ $HEALTHY -ne 1 ]]; then
    printf 'ERROR: health check failed\n' >&2
    [[ $USE_SYSTEMD -eq 1 ]] && journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2 || true
    if [[ -n "$PREVIOUS" && $USE_SYSTEMD -eq 1 ]]; then
      log "rolling back to $PREVIOUS"
      ln -sfn "$PREVIOUS" "$PREFIX/current"
      systemctl restart "$SERVICE_NAME"
    fi
    die "deploy aborted"
  fi
  log "healthy"
fi

# ── prune old releases ──
if [[ -d "$PREFIX/releases" ]]; then
  ls -1dt "$PREFIX/releases"/* 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf
fi

log "done: $(readlink -f "$PREFIX/current")"
if [[ $USE_SYSTEMD -eq 1 ]]; then
  log "logs: journalctl -u $SERVICE_NAME -f"
fi
