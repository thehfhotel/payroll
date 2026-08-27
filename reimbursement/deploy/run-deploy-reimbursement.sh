#!/bin/bash
#
# /srv/run-deploy-reimbursement.sh — forced-command shim for the
# reimbursement-v2 CI deploy identity on evergreen.
#
# Installed root:root 0755. Pinned in /home/reimbursement-v2/.ssh/authorized_keys:
#   command="/srv/run-deploy-reimbursement.sh",restrict ssh-ed25519 AAAA… gh-actions …
# so the key hf-finance's deploy-reimbursement.yml holds can ONLY run the verbs
# below — never a shell — even though the user is in the docker group.
#
# Unlike the /home/deploy shims (one JSON payload per deploy), this is an
# allow-list dispatcher on $SSH_ORIGINAL_COMMAND: the workflow drives the
# deploy as separate SSH steps because its HEAD-supersession guard sits
# between the smoke test and the first remote write, and its health check is
# a separate step with its own annotations. One verb per step, exact match,
# no arguments; anything that needs a body reads it from stdin.
#
#   smoke          print "connected as <user> on <host>"
#   write-compose  stdin → $DEPLOY_DIR/docker-compose.yml (0644, atomic)
#   write-env      stdin → $DEPLOY_DIR/.env (0600, atomic; KEY=VALUE lines only)
#   ghcr-login     stdin line 1 = user, line 2 = token → docker login ghcr.io
#   rollout        docker compose pull && docker compose up -d --remove-orphans
#   health         api /health inside the container, then web→api on :5800
#   prune          docker image prune -f
#
# Anything else — including a bare `ssh` with no command — is refused with
# exit 2 and the attempt is logged. Every invocation logs to
# /var/log/deploy/deploy-reimbursement-<timestamp>.log. Secrets (.env body,
# GHCR token) are never echoed.

set -euo pipefail

DEPLOY_DIR=/home/reimbursement-v2/production
LOG_DIR=/var/log/deploy
LOCK_FILE="$LOG_DIR/.run-deploy-reimbursement.lock"
MAX_COMPOSE_BYTES=$((1024 * 1024))
MAX_ENV_BYTES=$((256 * 1024))

VERB="${SSH_ORIGINAL_COMMAND-}"

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/deploy-reimbursement-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG_FILE") 2>&1

log() { echo "[deploy-reimbursement] $*"; }
die() { echo "::error::$*"; exit 1; }

log "start $(date -Iseconds) verb=${VERB:-<none>} caller=${SSH_CONNECTION:-local} user=$(id -un)"

# --- allow-list ------------------------------------------------------------
case "$VERB" in
  smoke|write-compose|write-env|ghcr-login|rollout|health|prune) ;;
  *)
    # Bounded, shell-quoted rendering so a hostile command can't smuggle
    # control characters into the log.
    printf '::error::refused: %q is not an allowed deploy verb (see /srv/run-deploy-reimbursement.sh)\n' \
      "${VERB:0:200}"
    exit 2
    ;;
esac

# Mutex for anything that touches on-disk or docker state. Opened AFTER the
# tee redirect so the tee child does not inherit fd 9 and hold the lock past
# our exit. -w rather than -n: consecutive workflow steps are back-to-back
# ssh sessions and a still-flushing predecessor must not fail the successor.
case "$VERB" in
  write-compose|write-env|ghcr-login|rollout|prune)
    exec 9>"$LOCK_FILE"
    flock -w 60 9 || die "another reimbursement deploy step still holds $LOCK_FILE"
    ;;
esac

# Snap-docker on this host periodically returns ENETUNREACH on outbound TCP
# during container churn — same helper the other shims carry.
retry_compose() {
  local attempt sleep_s
  for attempt in 1 2 3 4 5; do
    if docker compose "$@"; then
      return 0
    fi
    sleep_s=$((attempt * 5))
    echo "::warning::compose $* attempt $attempt failed, retrying in ${sleep_s}s"
    sleep "$sleep_s"
  done
  echo "::error::compose $* failed after 5 attempts"
  return 1
}

# Read stdin into $1 (a temp path), refusing anything over $2 bytes.
slurp_stdin() {
  local dest=$1 max=$2 size
  head -c $((max + 1)) > "$dest"
  size=$(stat -c %s "$dest")
  [ "$size" -gt 0 ] || die "empty body on stdin"
  [ "$size" -le "$max" ] || die "body on stdin exceeds ${max} bytes"
  echo "$size"
}

case "$VERB" in
  smoke)
    echo "connected as $(id -un) on $(hostname)"
    ;;

  write-compose)
    mkdir -p "$DEPLOY_DIR"
    tmp=$(mktemp "$DEPLOY_DIR/.docker-compose.yml.XXXXXX")
    trap 'rm -f "$tmp"' EXIT
    size=$(slurp_stdin "$tmp" "$MAX_COMPOSE_BYTES")
    grep -q '^services:' "$tmp" || die "refused: body has no top-level 'services:' — not a compose file"
    chmod 0644 "$tmp"
    mv -f "$tmp" "$DEPLOY_DIR/docker-compose.yml"
    trap - EXIT
    log "wrote docker-compose.yml (${size} bytes, sha256 $(sha256sum "$DEPLOY_DIR/docker-compose.yml" | cut -c1-16)…)"
    ;;

  write-env)
    mkdir -p "$DEPLOY_DIR"
    umask 077
    tmp=$(mktemp "$DEPLOY_DIR/.env.XXXXXX")
    trap 'rm -f "$tmp"' EXIT
    size=$(slurp_stdin "$tmp" "$MAX_ENV_BYTES")
    # Same shape rule as estate-ci's deploy-evergreen.yml: every non-blank,
    # non-comment line is KEY=VALUE. Values are withheld from the log.
    lineno=0
    while IFS= read -r line || [ -n "$line" ]; do
      lineno=$((lineno + 1))
      case "$line" in ''|'#'*) continue ;; esac
      [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] \
        || die "refused: .env line ${lineno} is not KEY=VALUE (value withheld)"
    done < "$tmp"
    image_tag=$(grep -E '^IMAGE_TAG=' "$tmp" | tail -1 | cut -d= -f2-)
    [ -n "$image_tag" ] || die "refused: .env has no IMAGE_TAG="
    chmod 0600 "$tmp"
    mv -f "$tmp" "$DEPLOY_DIR/.env"
    trap - EXIT
    log "wrote .env (${size} bytes, ${lineno} lines, IMAGE_TAG=${image_tag})"
    ;;

  ghcr-login)
    IFS= read -r ghcr_user || die "missing GHCR user on stdin line 1"
    IFS= read -r ghcr_token || true   # last line may lack a trailing newline
    # GitHub login: alphanumerics and hyphens; apps carry a [bot] suffix.
    # Held in a variable — a bracket expression can't contain a literal ]
    # in POSIX ERE, so an inline pattern with \[\] silently mis-parses.
    actor_re='^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(\[bot\])?$'
    [[ "$ghcr_user" =~ $actor_re ]] \
      || die "refused: GHCR user is not a plausible GitHub actor"
    [ -n "$ghcr_token" ] || die "missing GHCR token on stdin line 2"
    printf '%s\n' "$ghcr_token" | docker login ghcr.io -u "$ghcr_user" --password-stdin >/dev/null \
      || die "docker login ghcr.io failed"
    log "ghcr authenticated as ${ghcr_user}"
    ;;

  rollout)
    cd "$DEPLOY_DIR"
    [ -f docker-compose.yml ] || die "no docker-compose.yml in $DEPLOY_DIR — run write-compose first"
    [ -f .env ] || die "no .env in $DEPLOY_DIR — run write-env first"
    retry_compose pull
    docker compose up -d --remove-orphans
    docker compose ps
    ;;

  health)
    # Verbatim from the workflow's former inline health step. Track outcomes
    # in flags and fall through — no early exit mid-stream.
    set +e
    api_ok=0
    for i in $(seq 1 30); do
      if docker exec reimbursement-v2-api curl -fsS --max-time 3 http://localhost:3001/health >/dev/null 2>&1; then
        echo "api healthy after ${i}s"
        api_ok=1
        break
      fi
      sleep 2
    done
    if [ "$api_ok" != 1 ]; then
      echo "::error::api /health never came up"
      docker logs --tail=80 reimbursement-v2-api || true
      exit 1
    fi

    # /healthz/upstream, NOT /healthz: the bare path is nginx answering for
    # itself; /healthz/upstream proxies through to the api, same as real
    # traffic and the container HEALTHCHECK. 127.0.0.1:5800 is exactly the
    # web container's host port.
    edge_ok=0
    for i in $(seq 1 30); do
      if curl -fsS --max-time 3 http://127.0.0.1:5800/healthz/upstream >/dev/null 2>&1; then
        echo "web → api healthy on :5800 after ${i}s"
        edge_ok=1
        break
      fi
      sleep 2
    done
    if [ "$edge_ok" != 1 ]; then
      echo "::error::web :5800 health check failed"
      docker logs --tail=80 reimbursement-v2-web || true
      docker logs --tail=80 reimbursement-v2-api || true
      exit 1
    fi
    set -e
    echo "deploy looks healthy."
    ;;

  prune)
    docker image prune -f
    ;;
esac

log "done $(date -Iseconds) verb=${VERB} log=${LOG_FILE}"
find "$LOG_DIR" -name 'deploy-reimbursement-*.log' -type f -mtime +90 -delete 2>/dev/null || true
