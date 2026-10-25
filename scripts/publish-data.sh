#!/usr/bin/env bash
# Upload built resort data and redeploy the site.
#
#   scripts/publish-data.sh            # every resort with a committed config
#   scripts/publish-data.sh les-3-vallees arlberg
#   KEEP_INDEX=1 scripts/publish-data.sh les-3-vallees   # update one, leave the menu's list
#
# Resorts are built locally (uv run ski-sim build <id>). This stages data/processed/<id>
# for each one, plus a resorts.json listing just those, and uploads them:
# - to the Cloudflare R2 bucket named by the repo variable DATA_BUCKET, when it's set
#   (the site then reads data from the variable DATA_URL; see "Deployment" in CLAUDE.md).
#   Needs `npx wrangler login`. Files go up before resorts.json, so the menu never lists
#   a resort that isn't there yet;
# - otherwise into resorts.tar.gz on the GitHub `data` release (Pages' 1 GB site limit).
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -gt 0 ]; then
  ids=("$@")
else
  ids=()
  while IFS= read -r f; do ids+=("$(basename "$(dirname "$f")")"); done \
    < <(git ls-files 'data/resorts/*/resort.json')
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
staging="$work/resorts"
mkdir "$staging"
for id in "${ids[@]}"; do
  [ -f "data/processed/$id/manifest.json" ] || { echo "No build for $id: run uv run ski-sim build $id" >&2; exit 1; }
  cp -R "data/processed/$id" "$staging/"
done
python3 - "$staging" "${ids[@]}" <<'PY'
import json, sys
staging, ids = sys.argv[1], sys.argv[2:]
index = json.load(open("data/processed/resorts.json"))
index["resorts"] = [r for r in index["resorts"] if r["id"] in ids]
json.dump(index, open(f"{staging}/resorts.json", "w"), indent=2)
PY

bucket=$(gh variable get DATA_BUCKET 2>/dev/null || true)
if [ -n "$bucket" ]; then
  # Stay inside R2's free tier (infra/README.md): 10 GB stored, 1 M uploads a month. The
  # bucket's current size plus everything staged (as if nothing were overwritten) must
  # stay under MAX_GB, and one publish may upload at most MAX_FILES files.
  MAX_GB=9
  MAX_FILES=20000
  wrangler() { pnpm --dir infra/data-worker exec wrangler "$@"; }
  [ -d infra/data-worker/node_modules ] || pnpm --dir infra/data-worker install --frozen-lockfile
  info=$(wrangler r2 bucket info "$bucket" --json)
  current=$(python3 - "$info" <<'PY'
import json, re, sys
raw = sys.argv[1]
try:
    d = json.loads(raw)
    size = d.get("bucket_size") or d.get("bucketSize") or d.get("payloadSize") or 0
except ValueError:
    m = re.search(r"bucket_size:\s*([\d.]+)\s*(B|KB|MB|GB|TB)?", raw, re.I)
    size = m.group(0) if m else 0
units = {"B": 1, "KB": 1e3, "MB": 1e6, "GB": 1e9, "TB": 1e12}
if isinstance(size, str):
    m = re.search(r"([\d.]+)\s*(B|KB|MB|GB|TB)?", size, re.I)
    size = float(m.group(1)) * units[(m.group(2) or "B").upper()] if m else 0
print(int(size))
PY
)
  staged=$(du -sk "$staging" | cut -f1)
  files=$(find "$staging" -type f | wc -l | tr -d ' ')
  python3 - "$current" "$staged" "$files" "$MAX_GB" "$MAX_FILES" <<'PY'
import sys
current, staged_kb, files, max_gb, max_files = map(float, sys.argv[1:])
total = current + staged_kb * 1024
print(f"R2: {current / 1e9:.2f} GB stored + {staged_kb * 1024 / 1e9:.2f} GB staged, {int(files)} files")
if total > max_gb * 1e9:
    sys.exit(f"Refusing: that could reach {total / 1e9:.2f} GB, over the {max_gb:.0f} GB guard (10 GB free).")
if files > max_files:
    sys.exit(f"Refusing: {int(files)} uploads in one go is over the {int(max_files)} guard.")
PY
  # Manifests and the index are revalidated on every load; everything else is fetched
  # with ?v=<build time> (resortUrl), so it can be cached for a day.
  put() {
    local key=$1 file=$2 type cache="public, max-age=86400"
    case "$file" in
      *.json) type=application/json ;;
      *.png) type=image/png ;;
      *.jpg) type=image/jpeg ;;
      *) type=application/octet-stream ;;
    esac
    case "$key" in */manifest.json | resorts.json) cache="no-cache" ;; esac
    # R2 sometimes answers a put with a 500 ("internal error, please try again").
    local try
    for try in 1 2 3 4; do
      wrangler r2 object put "$bucket/$key" --file "$file" --content-type "$type" \
        --cache-control "$cache" --remote >/dev/null && return
      echo "Retrying $key" >&2
      sleep $((try * 5))
    done
    return 1
  }
  for id in "${ids[@]}"; do
    for file in "$staging/$id"/*; do
      [ "$(basename "$file")" = manifest.json ] || put "$id/$(basename "$file")" "$file"
    done
    put "$id/manifest.json" "$staging/$id/manifest.json"
    echo "Uploaded $id ($(du -sh "$staging/$id" | cut -f1))"
  done
  if [ "${KEEP_INDEX:-}" = 1 ]; then
    echo "Kept the live resorts.json (KEEP_INDEX=1)"
  else
    put resorts.json "$staging/resorts.json"
  fi
  echo "Uploaded to R2 bucket $bucket: ${ids[*]}"
  exit 0
fi

tar -czf "$work/resorts.tar.gz" -C "$staging" .
echo "Packed ${ids[*]}: $(du -h "$work/resorts.tar.gz" | cut -f1)"
gh release view data >/dev/null 2>&1 ||
  gh release create data --title "Resort data" --notes "Built resort data for the deployed site (scripts/publish-data.sh). Terrain: IGN (Licence Ouverte 2.0), Copernicus GLO-30; features: © OpenStreetMap contributors (ODbL)."
gh release upload data "$work/resorts.tar.gz" --clobber
gh workflow run deploy.yml
echo "Uploaded; the Deploy workflow is rebuilding the site."
