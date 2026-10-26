#!/usr/bin/env bash
# Runs scripts/local/monitor-endpoints.sh against a fixture fleet (a platform
# server with an app, an edge, a NAS) and holds its output to expected.json.
# Needs yq and jq; no network.
#   bash ci/tests/monitor/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
script="${here}/../../../scripts/local/monitor-endpoints.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fleet="${tmp}/fleet"
mkdir -p "${fleet}/servers/"{shop,edge,nas} "${fleet}/.cache/apps/shop/.git"
cat > "${fleet}/servers/shop/server.yml" <<'YAML'
kind: platform
target: hetzner
domain: shop.test
apps:
  - {name: shop, repo: https://github.com/example/shop.git, ref: main, path: .}
YAML
cat > "${fleet}/.cache/apps/shop/app.yml" <<'YAML'
name: shop
compose: [compose.yml]
routes:
  - {host: www, service: web, port: 3000}
  - {host: api, path: /signup, service: api, port: 3000}
YAML
printf 'kind: edge\ntarget: hetzner\ndomain: edge.test\n' > "${fleet}/servers/edge/server.yml"
cat > "${fleet}/servers/edge/vars.yml" <<'YAML'
edge_routes:
  - {subdomains: [git, media], upstream: "10.0.0.2:80"}
monitor:
  watch: [shop]
  extra:
    - {name: photos, url: "https://photos.nas.test/", server: nas, conditions: ["[STATUS] < 500"]}
YAML
printf 'kind: nas\ntarget: home\ndomain: nas.test\n' > "${fleet}/servers/nas/server.yml"
printf 'apex_redirect: www\nmonitor:\n  watch: [edge, nas]\n' > "${fleet}/servers/shop/vars.yml"
echo 'shop ansible_host=192.0.2.9 ansible_user=deploy' > "${fleet}/servers/shop/inventory.ini"
echo 'edge ansible_host=192.0.2.1 ansible_user=deploy' > "${fleet}/servers/edge/inventory.ini"
echo 'nas ansible_host=10.0.0.2 ansible_user=deploy' > "${fleet}/servers/nas/inventory.ini"

status=0
for server in edge shop; do
    got="$(FLEET_ROOT="$fleet" bash "$script" "$server" | jq -S .)"
    want="$(jq -S ".${server}" "${here}/expected.json")"
    if [ "$got" = "$want" ]; then echo "  ✓ ${server}"; else echo "  ✗ ${server}"; diff <(echo "$want") <(echo "$got") || true; status=1; fi
done
if FLEET_ROOT="$fleet" bash "$script" nas 2>/dev/null | jq -e '.monitor_endpoints == []' >/dev/null; then echo "  ✓ nas: no monitor, nothing"; else echo "  ✗ nas"; status=1; fi
printf 'monitor:\n  watch: [nowhere]\n' > "${fleet}/servers/nas/vars.yml"
if FLEET_ROOT="$fleet" bash "$script" nas >/dev/null 2>&1; then echo "  ✗ an unknown watched server passes"; status=1; else echo "  ✓ an unknown watched server is refused"; fi
exit "$status"
