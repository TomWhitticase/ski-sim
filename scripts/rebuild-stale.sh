#!/usr/bin/env bash
# Rebuild every resort whose build is out of date, on this machine.
#
#   scripts/rebuild-stale.sh            # rebuild what's stale
#   scripts/rebuild-stale.sh --dry-run  # just list what's stale, and why
#   scripts/rebuild-stale.sh --publish  # then upload every resort (scripts/publish-data.sh)
#
# A build is stale when the pipeline's code or dependencies, the resort's resort.json or
# the manifest version changed since it was built, or it was never built (see
# pipeline/.../fingerprint.py). Each pass only rebuilds what's still stale, so a resort
# that failed (Overpass is flaky) is retried on the next pass, up to $PASSES. Nothing is
# published unless every resort ends up current.
set -euo pipefail
cd "$(dirname "$0")/../pipeline"

publish=0
case "${1:-}" in
  --dry-run) exec uv run ski-sim build --stale --dry-run ;;
  --publish) publish=1 ;;
  "") ;;
  *) echo "usage: $0 [--dry-run | --publish]" >&2; exit 2 ;;
esac

PASSES=${PASSES:-3}
for pass in $(seq 1 "$PASSES"); do
  if uv run ski-sim build --stale; then
    break
  fi
  if [ "$pass" -eq "$PASSES" ]; then
    echo "Some resorts still failed after $PASSES passes; nothing published." >&2
    uv run ski-sim build --stale --dry-run >&2
    exit 1
  fi
  echo "Pass $pass had failures; retrying what's still stale." >&2
done

if [ "$publish" -eq 1 ]; then
  cd ..
  scripts/publish-data.sh
fi
