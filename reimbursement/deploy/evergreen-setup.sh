#!/usr/bin/env bash
#
# evergreen-setup.sh — idempotent first-time setup for the dedicated
# `reimbursement-v2` deploy user on evergreen.
#
# Each project on this host gets ITS OWN system user (not a shared
# `deploy` account), so two projects' CIs can't clobber each other's
# authorized_keys when GitHub Actions provisions them.
#
# Run on evergreen, as root or with sudo. Re-runnable.
#
# Usage (run-deploy-reimbursement.sh must sit next to this script):
#   sudo DEPLOY_SSH_PUBKEY='ssh-ed25519 AAAA…' bash evergreen-setup.sh
#
# The key is authorized with a FORCED COMMAND — the only thing it can do
# over SSH is run /srv/run-deploy-reimbursement.sh, an allow-list of seven
# deploy verbs. It never gets a shell, even though the user is in the
# docker group. Never append a bare key to authorized_keys by hand.
#

set -euo pipefail

DEPLOY_USER=reimbursement-v2
DEPLOY_HOME=/home/$DEPLOY_USER
APP_DIR=$DEPLOY_HOME/production

# ── Preflight ────────────────────────────────────────────────────────
if [ "$(id -u)" != "0" ]; then
  echo "::error::run as root (or with sudo)" >&2
  exit 1
fi

: "${DEPLOY_SSH_PUBKEY:?Set DEPLOY_SSH_PUBKEY to the public half of the GitHub Actions ed25519 key (single line, starts with ssh-ed25519)}"

if ! command -v docker >/dev/null 2>&1; then
  echo "::error::docker is not installed on this host" >&2
  exit 1
fi

# ── 1. User ──────────────────────────────────────────────────────────
if id -u "$DEPLOY_USER" >/dev/null 2>&1; then
  echo "✓ user $DEPLOY_USER already exists"
else
  echo "+ creating system user $DEPLOY_USER"
  useradd --system --create-home --shell /bin/bash "$DEPLOY_USER"
fi

# Lock the password so this account can ONLY log in via the SSH keys we
# explicitly authorize below — no password fallback ever, even if sshd is
# misconfigured later. Idempotent (passwd -l is a no-op if already locked).
passwd -l "$DEPLOY_USER" >/dev/null
echo "✓ password authentication disabled for $DEPLOY_USER"

# ── 2. docker group ──────────────────────────────────────────────────
if id -nG "$DEPLOY_USER" | tr ' ' '\n' | grep -qx docker; then
  echo "✓ $DEPLOY_USER already in docker group"
else
  echo "+ adding $DEPLOY_USER to docker group"
  usermod -aG docker "$DEPLOY_USER"
fi

# ── 3. Forced-command shim ───────────────────────────────────────────
SHIM=/srv/run-deploy-reimbursement.sh
SHIM_SRC=$(dirname "$(readlink -f "$0")")/run-deploy-reimbursement.sh
if [ -f "$SHIM_SRC" ]; then
  install -o root -g root -m 0755 "$SHIM_SRC" "$SHIM"
  echo "✓ installed $SHIM from $SHIM_SRC"
elif [ -x "$SHIM" ]; then
  echo "✓ $SHIM already present (no source copy next to this script; left as is)"
else
  echo "::error::$SHIM is missing and run-deploy-reimbursement.sh is not next to this script" >&2
  exit 1
fi

# The shim logs to the host-wide /var/log/deploy, owned by the `deploy`
# user. Group docker (every deploy identity on this host is in it) gets
# write; the sticky bit keeps one identity from deleting another's logs.
mkdir -p /var/log/deploy
chgrp docker /var/log/deploy
chmod 1775 /var/log/deploy

# ── 4. SSH authorized_keys ───────────────────────────────────────────
SSH_DIR=$DEPLOY_HOME/.ssh
AUTH_KEYS=$SSH_DIR/authorized_keys
mkdir -p "$SSH_DIR"
touch "$AUTH_KEYS"

KEY_LINE="command=\"$SHIM\",restrict $DEPLOY_SSH_PUBKEY"
if grep -qF -- "$KEY_LINE" "$AUTH_KEYS"; then
  echo "✓ pubkey already authorized (forced command)"
elif grep -qF -- "$DEPLOY_SSH_PUBKEY" "$AUTH_KEYS"; then
  # A bare (unrestricted) copy of this key is exactly the finding this
  # script exists to prevent. Refuse rather than silently leave it.
  echo "::error::pubkey is in $AUTH_KEYS WITHOUT the forced command — prefix that line with: command=\"$SHIM\",restrict" >&2
  exit 1
else
  echo "+ authorizing pubkey (forced command → $SHIM)"
  printf '%s\n' "$KEY_LINE" >> "$AUTH_KEYS"
fi

chown -R "$DEPLOY_USER:$DEPLOY_USER" "$SSH_DIR"
chmod 700 "$SSH_DIR"
chmod 600 "$AUTH_KEYS"

# ── 5. App directory ─────────────────────────────────────────────────
if [ -d "$APP_DIR" ]; then
  echo "✓ $APP_DIR already exists"
else
  echo "+ creating $APP_DIR"
  mkdir -p "$APP_DIR"
fi
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$APP_DIR"

# ── 6. Print next steps ──────────────────────────────────────────────
cat <<EOF

──────────────────────────────────────────────────────────────────
✓ deploy user is ready.

  user:   $DEPLOY_USER
  home:   $DEPLOY_HOME
  dir:    $APP_DIR
  groups: $(id -Gn "$DEPLOY_USER")

Next steps (off this host):

  1. From your laptop, prove the key works AND is confined (replace <key>
     with the GH Actions ed25519 PRIVATE key file):

       ssh -i <key> -o IdentitiesOnly=yes ${DEPLOY_USER}@evergreen.thehfhotel.org smoke
       ssh -i <key> -o IdentitiesOnly=yes ${DEPLOY_USER}@evergreen.thehfhotel.org id   # must be refused, exit 2

  2. Pin the host's SSH host key for the GH Actions known_hosts secret:

       ssh-keyscan -t ed25519 evergreen.thehfhotel.org

     Save the output as the GitHub repo secret REIMB_SSH_KNOWN_HOSTS
     (on thehfhotel/payroll — the monorepo repo, not this app's old one).

  3. Set the rest of the GitHub repo secrets — see DEPLOYMENT.md.

  4. Push to main — the deploy workflow takes it from here.
──────────────────────────────────────────────────────────────────
EOF
