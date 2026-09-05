# The playwright version in kbiz-bot/package.json MUST be pinned exactly to
# this base image tag — the image ships that version's browsers, and a newer
# library refuses to launch them (bot crashloops with "Executable doesn't
# exist"). Bump both together.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# kbiz-bot lives at /app/kbiz-bot so resolve("..", "data", ...) hits /app/data,
# matching how docker-compose mounts the shared data volume into both
# payroll-form (at /app/data) and this container.
WORKDIR /app/kbiz-bot

# Thai font shaping for headless-Chromium PDF rendering (the payment voucher
# attached to transfer-other transfers) — the noble base image ships no Thai
# fonts by default, so unpatched glyphs render as tofu boxes in the PDF.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-thai-tlwg \
  && rm -rf /var/lib/apt/lists/*

COPY kbiz-bot/package.json ./
RUN npm install --include=dev

# The KBIZ contract (KbizPaymentIntent, KbizDestination, KbizFavorite, the memo
# rules) is imported from reimbursement's shared package AT SOURCE, so it has to
# exist in the image at the path kbiz-bot/tsconfig.json maps it to. tsx runs
# from /app/kbiz-bot, so `../reimbursement/packages/shared/src/index.ts` is
# /app/reimbursement/packages/shared/src/index.ts — spelled absolutely here so
# the layout is stated, not inferred from the WORKDIR.
#
# Build context is the REPO ROOT (docker-compose `context: .` + `dockerfile:
# kbiz-bot/Dockerfile`, and the same pair in .github/workflows/deploy.yml), which
# is what makes both this and the COPY above reachable. Source only: the repo
# .dockerignore drops `**/node_modules` from the context entirely, so this can
# never drag an installed tree in. Copied BEFORE the bot's own src so an
# ordinary bot change reuses this layer.
COPY reimbursement/packages/shared /app/reimbursement/packages/shared

# tsx reads the `paths` mapping out of tsconfig.json at RUNTIME — but the repo
# .dockerignore excludes `kbiz-bot/*.json` (only package.json is re-included),
# so tsconfig.json is not even in the build context and COPYing it would fail
# the build. Node's own resolution is therefore what carries the bare specifier
# inside the container: this link makes `@reimbursement/shared` resolve through
# node_modules to the very same file the tsconfig maps to (verified: tsx
# transpiles the package's .ts entry point via its "exports" field). Local dev,
# tsc and `bun test` keep using the tsconfig mapping — same file either way.
#
# If the root .dockerignore ever un-ignores kbiz-bot/tsconfig.json, COPY it in
# and this link becomes belt-and-braces rather than the only mechanism.
RUN mkdir -p node_modules/@reimbursement \
  && ln -sfn /app/reimbursement/packages/shared node_modules/@reimbursement/shared

COPY kbiz-bot/src ./src

ENV KBIZ_HEADLESS=1
ENV QUEUE_POLL_MS=30000

# Run the queue watcher. Skip --env-file flag (compose injects env vars).
# Ctrl+C / docker stop ends it cleanly.
CMD ["node", "--import", "tsx", "src/process-queue.ts", "--watch"]
