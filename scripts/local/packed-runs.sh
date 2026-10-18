#!/usr/bin/env bash
# Packs kayra as npm publishes it, installs the tarball the way a fleet does,
# and runs it: its version, its help, and kayra ui answering with its browser
# side. Run by release.yml before npm publish, and by hand before a release.
#   bash scripts/local/packed-runs.sh
set -euo pipefail
here="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'kill "${ui:-}" 2>/dev/null || true; rm -rf "$work"' EXIT

tarball="$(cd "$here" && npm pack --silent --pack-destination "$work" | tail -1)"
mkdir -p "${work}/fleet/servers"
printf 'acme_email: ops@example.com\n' > "${work}/fleet/servers/defaults.yml"
(cd "${work}/fleet" && npm init -y >/dev/null && npm install --silent --no-audit --no-fund "${work}/${tarball}")
kayra="${work}/fleet/node_modules/@yunuseon/kayra/bin/kayra.js"

version="$(cd "${work}/fleet" && node "$kayra" --version)"
expected="$(node -p "require('${here}/package.json').version")"
[ "$version" = "$expected" ] || { echo "✗ the packed kayra says ${version}, not ${expected}" >&2; exit 1; }
(cd "${work}/fleet" && node "$kayra" --help >/dev/null)

(cd "${work}/fleet" && node "$kayra" ui --no-open --port 0 > "${work}/ui.out" 2>&1) &
ui=$!
for _ in $(seq 1 50); do grep -q '/login?token=' "${work}/ui.out" && break; sleep 0.2; done
url="$(grep -o 'http://127.0.0.1:[0-9]*/login?token=[A-Za-z0-9_-]*' "${work}/ui.out")" || { cat "${work}/ui.out" >&2; echo "✗ kayra ui did not start" >&2; exit 1; }
page="$(curl -sf -L -c "${work}/jar" -b "${work}/jar" "$url")"
grep -q '<script type="module"' <<< "$page" || { echo "✗ kayra ui serves no built browser side" >&2; exit 1; }
echo "✓ the packed kayra ${version} runs, and kayra ui serves its browser side"
