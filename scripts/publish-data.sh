#!/usr/bin/env bash
# Upload built resort data and redeploy the site.
#
#   scripts/publish-data.sh            # every resort with a committed config
#   scripts/publish-data.sh les-3-vallees arlberg
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
  # Manifests and the index are revalidated on every load; everything else is fetched
  # with ?v=<build time> (resortUrl), so it can be cached for a day.
  put() {
    local key=$1 file=$2 type cache="public, max-age=86400"
    case "$file" in
      *.json) type=application/json ;;
      *.png) type=image/png ;;
      *) type=application/octet-stream ;;
    esac
    case "$key" in */manifest.json | resorts.json) cache="no-cache" ;; esac
    npx -y wrangler r2 object put "$bucket/$key" --file "$file" --content-type "$type" \
      --cache-control "$cache" --remote >/dev/null
  }
  for id in "${ids[@]}"; do
    for file in "$staging/$id"/*; do
      [ "$(basename "$file")" = manifest.json ] || put "$id/$(basename "$file")" "$file"
    done
    put "$id/manifest.json" "$staging/$id/manifest.json"
    echo "Uploaded $id ($(du -sh "$staging/$id" | cut -f1))"
  done
  put resorts.json "$staging/resorts.json"
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
