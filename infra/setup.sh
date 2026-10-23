#!/usr/bin/env bash
# Creates (or brings back into line) the resort data hosting on Cloudflare, idempotently:
#   - R2 bucket `ski-sim-data`, private: its public r2.dev URL is switched off, no custom
#     domains, so the only way to read it is the Worker below;
#   - Worker `ski-sim-data` (data-worker/), read-only, at ski-sim-data.<subdomain>.workers.dev.
#
#   infra/setup.sh --free-plan-checked
#
# The cost guarantee rests on the account staying on the Workers *Free* plan (a capped
# 100,000 requests a day, never billed). Wrangler's login can't read billing, so check it
# by hand at https://dash.cloudflare.com/?to=/:account/workers/plans ("Current plan" on
# Free) and pass --free-plan-checked. See infra/README.md.
set -euo pipefail
cd "$(dirname "$0")/data-worker"

BUCKET=ski-sim-data
if [ "${1:-}" != "--free-plan-checked" ]; then
  echo "Check the Workers plan is Free: https://dash.cloudflare.com/?to=/:account/workers/plans" >&2
  echo "then run: infra/setup.sh --free-plan-checked" >&2
  exit 1
fi

[ -d node_modules ] || pnpm install --frozen-lockfile
wrangler() { pnpm exec wrangler "$@"; }

if wrangler r2 bucket info "$BUCKET" >/dev/null 2>&1; then
  echo "Bucket $BUCKET exists"
else
  wrangler r2 bucket create "$BUCKET"
fi

# No public access except through the Worker.
wrangler r2 bucket dev-url disable "$BUCKET" --force >/dev/null 2>&1 || true
if wrangler r2 bucket dev-url get "$BUCKET" 2>&1 | grep -qi "enabled"; then
  echo "Refusing to go on: the bucket's public r2.dev URL is still enabled." >&2
  exit 1
fi
if wrangler r2 bucket domain list "$BUCKET" 2>&1 | grep -qiE "domain:|enabled"; then
  echo "Refusing to go on: the bucket has a custom domain (a way round the Worker's cap)." >&2
  exit 1
fi

pnpm typecheck
wrangler deploy
echo
echo "Done. Set the repo variables (once):"
echo "  gh variable set DATA_BUCKET --body $BUCKET"
echo "  gh variable set DATA_URL --body https://ski-sim-data.<subdomain>.workers.dev/"
