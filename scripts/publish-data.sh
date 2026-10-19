#!/usr/bin/env bash
# Upload built resort data to the GitHub `data` release and redeploy the site.
#
#   scripts/publish-data.sh            # every resort with a committed config
#   scripts/publish-data.sh les-3-vallees arlberg
#
# Resorts are built locally (uv run ski-sim build <id>); this packs data/processed/<id>
# for each one, plus a resorts.json listing just those, into resorts.tar.gz.
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

tar -czf "$work/resorts.tar.gz" -C "$staging" .
echo "Packed ${ids[*]}: $(du -h "$work/resorts.tar.gz" | cut -f1)"
gh release view data >/dev/null 2>&1 ||
  gh release create data --title "Resort data" --notes "Built resort data for the deployed site (scripts/publish-data.sh). Terrain: IGN (Licence Ouverte 2.0), Copernicus GLO-30; features: © OpenStreetMap contributors (ODbL)."
gh release upload data "$work/resorts.tar.gz" --clobber
gh workflow run deploy.yml
echo "Uploaded; the Deploy workflow is rebuilding the site."
