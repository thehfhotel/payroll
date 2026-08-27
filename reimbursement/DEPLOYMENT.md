# Deployment

How `reimbursement-v2` ships from `main` → `https://reimbursement.thehfhotel.org`.

## Topology

```
GitHub Actions (ubuntu-latest)
    │
    │ 1. build api+web → push to ghcr.io
    │
    │ 2. ssh to evergreen via cloudflared (Cloudflare Access service token)
    │
    ▼
evergreen (Ubuntu)
  ├── reimbursement-v2 user (locked password, ssh-key only, in `docker` group)
  │     ├── key pinned to /srv/run-deploy-reimbursement.sh (forced command,
  │     │   seven deploy verbs — never a shell)
  │     └── ~/production/{docker-compose.yml, .env}
  │
  └── docker daemon
        ├── reimbursement-v2-postgres   (private network only)
        ├── reimbursement-v2-api        (private network only)
        └── reimbursement-v2-web        bound to 127.0.0.1:5800
                              ▲
                              │
        Cloudflare Tunnel (asgard) ──▶ reimbursement.thehfhotel.org
                              │
                    Cloudflare Access application (Google for managers,
                    HF ID for employees) — managed in hf-erp's
                    infra/cloudflare hostnames.json
                              │
                       public internet
```

The web container has its own internal nginx — handles SPA fallback and
proxies `/api` + `/uploads` to the api container. There is no host-level
nginx; cloudflared routes the public hostname directly to host port 5800.
The port is bound to the loopback so it's reachable only via the tunnel.
The public hostname itself sits behind a Cloudflare Access application
(managed in hf-erp's `infra/cloudflare/hostnames.json`, not in this repo);
the app JWT exchange re-verifies the Access assertion at the origin rather
than trusting the edge.

## Repo secrets (Settings → Secrets and variables → Actions, on `thehfhotel/hf-finance` — the monorepo repo, since the 2026-08-12 cutover)

> All reimbursement-specific secrets that could collide with the payroll
> stack's own names are prefixed `REIMB_`. Secrets below WITHOUT that prefix
> (`JWT_SECRET`, `CF_ACCESS_AUD`, `POSTGRES_PASSWORD`, `READER_RESOLVE_SECRET`,
> `HF_ID_BASE_URL`, `HF_ID_ISSUER`, `SLACK_WEBHOOK_URL`) are deliberately
> shared with the root `deploy.yml` (payroll + kbiz-bot) pipeline — one
> HF-ID service, one Slack webhook, read by both. Rotating any of those
> requires redeploying BOTH stacks (push here AND to `main` for the root
> pipeline) or they drift out of sync silently. See root `CLAUDE.md`.

| Secret | Required? | Purpose |
|---|---|---|
| `REIMB_SSH_PRIVATE_KEY` | **Required** | ed25519 private key for `reimbursement-v2@evergreen` |
| `REIMB_SSH_KNOWN_HOSTS` | **Required** | host key — `evergreen.thehfhotel.org ssh-ed25519 …` |
| `CF_ACCESS_CLIENT_ID` | optional | Cloudflare Access service token id, only if the evergreen SSH tunnel has an Access app |
| `CF_ACCESS_CLIENT_SECRET` | optional | Cloudflare Access service token secret |
| `JWT_SECRET` | **Required** | App JWT signing key — `openssl rand -base64 48` |
| `CF_ACCESS_TEAM_DOMAIN` | optional, has default | Team domain for the login-verifying Access app, e.g. `laikaexpress.cloudflareaccess.com` — falls back to that default if unset |
| `CF_ACCESS_AUD` | **Required** | AUD tag of the reimbursement Access application (Cloudflare Zero Trust → Access → Applications → app → Overview); read back via the Cloudflare API (`GET /accounts/:id/access/apps`) when auditing the app |
| `POSTGRES_PASSWORD` | **Required** | Strong DB password — `openssl rand -base64 32` |
| `READER_RESOLVE_SECRET` | optional, fails **dark** | app↔central HF-ID card-login secret. Unset ⇒ card login stays disabled (503), nothing else breaks. Shared with the root pipeline. |
| `HF_ID_BASE_URL` | optional, has default | central HF ID base URL (default `http://192.168.100.228:5000`). Shared with the root pipeline. |
| `HF_ID_ISSUER` | optional, has default | expected card-assertion issuer (default `https://id.thehfhotel.org/oidc`). Shared with the root pipeline. |
| `KIOSK_EMAILS` | optional, has default | shared-terminal `email=kiosk-id,…` pairs; defaults to the two reception PCs |
| `NOTIFY_INGRESS_TOKEN` | optional, fails **dark** | HF One portal notification ingress token. Unset ⇒ approver "request submitted" notifications silently never send — nothing else fails or reports it. New to this repo at cutover (was already set on the old `reimbursement-v2` repo); verify it's set as a **post-deploy check**, not just a copy-the-secret checklist item. |
| `HF_ERP_BASE_URL` | optional, has default | base URL for the HF One portal (default `http://192.168.100.228:4020`) |
| `SLACK_WEBHOOK_URL` | optional, fails dark | KBIZ queue alerts. Shared with the root pipeline. |

`KBIZ_QUEUE_HOST_DIR` is **not** a secret — it's a fixed literal
(`/home/deploy/kbiz-queue`) hardcoded in `deploy-reimbursement.yml`, because
it must stay identical to the payroll/kbiz-bot stack's own compose default.
Making it secret-configurable here without a matching change on the payroll
side would let one repo secret silently split the two stacks onto different
directories with no error anywhere. If the path ever needs to change, change
it in both workflows in the same commit.

## First-time setup

### 1. Create the deploy SSH key (on your laptop)

```bash
ssh-keygen -t ed25519 -N '' -f ~/.ssh/reimbursement-v2-deploy \
  -C 'gh-actions deploy@reimbursement-v2'

cat ~/.ssh/reimbursement-v2-deploy.pub   # → goes to evergreen (next step)
cat ~/.ssh/reimbursement-v2-deploy       # → goes into REIMB_SSH_PRIVATE_KEY secret (on thehfhotel/hf-finance)
```

### 2. Provision the deploy user on evergreen

```bash
scp deploy/evergreen-setup.sh deploy/run-deploy-reimbursement.sh evergreen:/tmp/
ssh evergreen
sudo DEPLOY_SSH_PUBKEY='ssh-ed25519 AAAA… gh-actions deploy@reimbursement-v2' \
  bash /tmp/evergreen-setup.sh
```

The script is idempotent. It creates the `reimbursement-v2` system user with
**password authentication locked** (`passwd -l`), adds it to the `docker`
group, installs `/srv/run-deploy-reimbursement.sh` (root-owned), and
authorizes the public key **pinned to that shim**:

```
command="/srv/run-deploy-reimbursement.sh",restrict ssh-ed25519 AAAA… gh-actions deploy@reimbursement-v2
```

Re-run any time you need to add a second authorized key, update the shim, or
recreate the app directory. It refuses to proceed if it finds the key already
present *without* the forced command — fix that line by hand first.

#### The forced-command shim

The key can only ever run the shim, and the shim only accepts one bare verb
as the remote command (anything else, including a bare `ssh` with a script on
stdin, is refused with exit 2 and logged to
`/var/log/deploy/deploy-reimbursement-<ts>.log`):

| Verb | What it does |
|---|---|
| `smoke` | prints `connected as reimbursement-v2 on evergreen` |
| `write-compose` | stdin → `~/production/docker-compose.yml` (0644, atomic, must contain `services:`) |
| `write-env` | stdin → `~/production/.env` (0600, atomic; every line must be `KEY=VALUE`, must contain `IMAGE_TAG=`) |
| `ghcr-login` | stdin line 1 = user, line 2 = token → `docker login ghcr.io` |
| `rollout` | `docker compose pull && docker compose up -d --remove-orphans` |
| `health` | api `/health` inside the container, then web → api on `127.0.0.1:5800/healthz/upstream` |
| `prune` | `docker image prune -f` |

`deploy-reimbursement.yml` sends exactly one verb per step. The source of
truth is `deploy/run-deploy-reimbursement.sh` in this repo; the installed copy
must match it.

### 3. Pin the host key

```bash
ssh-keyscan -t ed25519 evergreen.thehfhotel.org > /tmp/evergreen-known-host
cat /tmp/evergreen-known-host   # paste into the REIMB_SSH_KNOWN_HOSTS GitHub secret (on thehfhotel/hf-finance)
```

### 4. Cloudflare Access service token *(optional)*

The evergreen SSH cloudflared tunnel currently has no Access app enforcing
auth — any client that can reach the tunnel hostname is routed through, and
authentication is the SSH server's responsibility (key-based). The
`cloudflared access ssh --hostname %h` ProxyCommand works without
credentials in this mode.

If you later add an Access app for `evergreen.thehfhotel.org` of type SSH:

1. Cloudflare Zero Trust → **Access → Service Auth → Service Tokens** →
   *Create Service Token*. Name it `gh-actions-reimbursement-v2`.
2. **Access → Applications** → open the SSH app → *Policies* → add a policy
   with action `Service Auth`, including the new token.
3. Set the two GitHub secrets:
   ```bash
   printf '%s' '<client-id>'     | gh secret set CF_ACCESS_CLIENT_ID --repo thehfhotel/hf-finance
   printf '%s' '<client-secret>' | gh secret set CF_ACCESS_CLIENT_SECRET --repo thehfhotel/hf-finance
   ```

The deploy workflow auto-detects whether the secrets are set; if both are
present it includes them in the cloudflared ProxyCommand, otherwise it
runs without.

### 5. Cloudflare tunnel cutover

The hostname `reimbursement.thehfhotel.org` already proxies through the
asgard tunnel (CNAME exists), but the ingress rule still points at the OLD
app on host port 3000. After the new app is deployed and healthy on host
port 5800, flip the rule. As the user that owns `~/.config/cloudflare/`:

```bash
TOKEN=$(tr -d '[:space:]' < ~/.config/cloudflare/token)
ACCT=$(tr -d '[:space:]'  < ~/.config/cloudflare/account)
TUN=$(awk '$1 == "asgard" {print $2}' ~/.config/cloudflare/tunnels)
API="https://api.cloudflare.com/client/v4"

cur=$(curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$API/accounts/$ACCT/cfd_tunnel/$TUN/configurations" | jq '.result.config')

new=$(echo "$cur" | jq '
  .ingress |= (
    map(if .hostname == "reimbursement.thehfhotel.org"
        then .service = "http://192.168.100.228:5800"
        else . end))')

curl -fsS -X PUT \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --argjson c "$new" '{config: $c}')" \
  "$API/accounts/$ACCT/cfd_tunnel/$TUN/configurations" | jq '{success, errors}'
```

Rollback is the same call with `:3000` (or whatever the previous port was)
in place of `:5800`. Cloudflare propagates the change in under 60 seconds.

### 6. Trigger the first deploy

```bash
git push origin main
```

Watch the run at <https://github.com/thehfhotel/hf-finance/actions> (workflow:
"Reimbursement Build & Deploy", `.github/workflows/deploy-reimbursement.yml`
at the monorepo root — the old `thehfhotel/reimbursement-v2` repo is archived
history and no longer runs any pipeline).

## Day-2 operations

### Manual migration

The api container's entrypoint runs `prisma migrate deploy` on boot. To
apply schema changes outside of a deploy:

```bash
ssh evergreen 'docker exec reimbursement-v2-api bunx prisma migrate deploy'
```

### Inspect prod data

```bash
ssh evergreen 'docker exec -it reimbursement-v2-postgres psql -U postgres -d reimbursement'
```

### Rollback

Each deploy pins `IMAGE_TAG=sha-<commit>` in `~/production/.env`
on evergreen. To roll back, edit that file, change `IMAGE_TAG=` to the
previous sha, then:

```bash
ssh evergreen <<'SH'
cd ~/production
docker compose pull
docker compose up -d --remove-orphans
SH
```

> **Cutover gap (2026-08-12 monorepo move):** this only works for shas built
> under the CURRENT image names,
> `ghcr.io/thehfhotel/payroll-reimbursement-{api,web}`. Those are brand-new
> GHCR packages — the rename in `deploy-reimbursement.yml` means every
> pre-cutover sha lives only under the OLD package names,
> `ghcr.io/thehfhotel/reimbursement-v2-{api,web}`. Rolling back to anything
> older than the first monorepo deploy needs `IMAGE_TAG=` AND the image
> repository in `docker-compose.yml` on the host both changed back to the
> old name — editing `IMAGE_TAG=` alone gets "manifest unknown" from
> `docker compose pull`.
>
> **Before merging the monorepo cutover**, mirror the last pre-cutover
> production sha into the new package names so a same-name rollback target
> exists for the deploy most likely to need one:
>
> ```bash
> docker buildx imagetools create \
>   -t ghcr.io/thehfhotel/payroll-reimbursement-api:sha-<last-good> \
>   ghcr.io/thehfhotel/reimbursement-v2-api:sha-<last-good>
> docker buildx imagetools create \
>   -t ghcr.io/thehfhotel/payroll-reimbursement-web:sha-<last-good> \
>   ghcr.io/thehfhotel/reimbursement-v2-web:sha-<last-good>
> ```
>
> This is a manual, credentialed registry operation — not something CI does
> for you, and not done as part of this doc edit. It's tracked as a cutover
> checklist item in `docs/change-requests/CR-2026-08-12-finance-monorepo.md`.

### Logs

```bash
ssh evergreen 'docker logs --tail=200 -f reimbursement-v2-api'
ssh evergreen 'docker logs --tail=200 -f reimbursement-v2-web'
ssh evergreen 'docker logs --tail=200 -f reimbursement-v2-postgres'
```

### Backups

```bash
ssh evergreen <<'SH'
ts=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p ~/backups/reimbursement-v2
docker run --rm \
  -v reimbursement_v2_postgres_data:/data:ro \
  -v ~/backups/reimbursement-v2:/out \
  alpine tar -czf /out/postgres-${ts}.tar.gz -C /data .
docker run --rm \
  -v reimbursement_v2_uploads_data:/data:ro \
  -v ~/backups/reimbursement-v2:/out \
  alpine tar -czf /out/uploads-${ts}.tar.gz -C /data .
SH
```

Wire into cron / systemd-timer on evergreen for automatic snapshots.

## Why this shape

- **GH-hosted runner + SSH** instead of a self-hosted runner: no long-lived
  agent on evergreen, no daemon to keep updated, blast radius of a
  compromised workflow run is "the seven verbs of
  `/srv/run-deploy-reimbursement.sh`" — the key is a forced command, not a
  shell, so it cannot reach the docker socket directly.
- **Cloudflare Access service token** instead of opening SSH to the
  internet: zero net-new attack surface. Same Access policy that lets your
  laptop in lets the workflow in.
- **Public-key SSH only, no password fallback**: the deploy user's password
  is locked (`passwd -l`) on evergreen. Client-side, the workflow's SSH
  config sets `PreferredAuthentications publickey`, `PasswordAuthentication
  no`, `KbdInteractiveAuthentication no`, `BatchMode yes` — so even a
  compromised server config can't downgrade the auth method.
- **Pinned host key**: protects against an evil cloudflared / man-in-tunnel
  swapping the host out from under us.
- **No nginx in front**: the web container's own nginx is enough — SPA
  fallback + `/api` proxy. Removing the host-level shared-nginx layer cuts
  one moving piece, one config file the deploy user couldn't write to, and
  one place for vhost drift.
- **Loopback-only host port (`127.0.0.1:5800`)**: the public can only reach
  the web container through the Cloudflare Tunnel, never directly via the
  host's IP.
- **`umask 077` + `chmod 600` on `.env`**: secrets never have a
  world-readable window on either the runner or evergreen.
- **Image tags pinned by sha** on the deploy host: rollback is "edit one
  line, `docker compose up -d`" — no need to re-run a workflow.
- **No host port for the api**: the api is reachable only via the web
  container's nginx over a private Docker network. Postgres is the same.
