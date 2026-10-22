#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if command -v cygpath >/dev/null 2>&1; then root="$(cygpath -m "$root")"; fi
docker info >/dev/null
for version in 1.3.0 1.4.0; do
  echo "=== Pi $version ==="
  MSYS_NO_PATHCONV=1 docker run --rm \
    --mount "type=bind,src=$root,dst=/src,readonly" \
    -e PI_OFFLINE=1 -e "PI_TEST_VERSION=$version" \
    node:24.21.0-bookworm-slim bash -euc '
      mkdir -p /tmp/check
      cp -R /src/src /src/tests /src/tsconfig.json /src/package.json /tmp/check/
      cd /tmp/check
      npm install --ignore-scripts --no-package-lock --no-save --no-audit --no-fund \
        "@earendil-works/pi-coding-agent@$PI_TEST_VERSION" "@earendil-works/pi-ai@$PI_TEST_VERSION"
      npm run check
      npm test
    '
done
