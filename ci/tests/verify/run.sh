#!/usr/bin/env bash
# Runs scripts/local/verify.sh against a fixture server whose answers come
# from stubs (curl, openssl, ssh), one case per way a server has broken: each
# case changes one answer of a healthy server and names the ✗ line it must
# produce (or "nothing"), or the "! " line it notes and passes with. Needs yq
# and jq; no network, no server.
#   bash ci/tests/verify/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
verify="${here}/../../../scripts/local/verify.sh"
failed=0

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fleet="${tmp}/fleet"
mkdir -p "${fleet}/servers/shop" "${fleet}/.cache/apps/shop/.git" "${tmp}/bin"
cat > "${fleet}/servers/shop/server.yml" <<'EOF'
kind: platform
target: hetzner
domain: shop.test
apps:
  - {name: shop, repo: https://github.com/example/shop.git, ref: main, path: .}
EOF
echo '[servers]
shop ansible_host=192.0.2.9 ansible_port=22 ansible_user=deploy ansible_ssh_private_key_file=/keys/shop' > "${fleet}/servers/shop/inventory.ini"
cat > "${fleet}/.cache/apps/shop/app.yml" <<'EOF'
name: shop
compose: [compose.yml]
routes:
  - {host: www, service: web, port: 3000}
  - {host: api, path: /signup, service: api, port: 3000}
EOF

# curl: answers/<host>[_<path>] (or answers/hook for a webhook); openssl: issuer/<host>; ssh: facts.
cat > "${tmp}/bin/curl" <<'EOF'
#!/usr/bin/env bash
for arg in "$@"; do case "$arg" in https://*) url="$arg" ;; esac; done
page="${url#https://}"; page="${page%/}"
case "$url" in */hook/*) cat "${ANSWERS}/hook" ;; *) cat "${ANSWERS}/${page//\//_}" ;; esac
EOF
cat > "${tmp}/bin/openssl" <<'EOF'
#!/usr/bin/env bash
case "$1" in
    s_client) while [ $# -gt 0 ]; do [ "$1" = -servername ] && host="$2"; shift; done; cat "${ANSWERS}/issuer-${host}" ;;
    x509) echo "issuer=CN = $(cat)" ;;
esac
EOF
echo '#!/usr/bin/env bash
cat "${ANSWERS}/facts"' > "${tmp}/bin/ssh"
chmod +x "${tmp}/bin/"*

answer() { printf '%s' "$2" > "${tmp}/answers/$1"; }
healthy() {
    rm -rf "${tmp}/answers"; mkdir -p "${tmp}/answers"
    for host in auth.shop.test deploy.shop.test traefik.shop.test www.shop.test api.shop.test; do answer "issuer-${host}" "R13"; done
    answer auth.shop.test "200  0"
    answer deploy.shop.test "302 https://auth.shop.test/?rd=x 0"
    answer traefik.shop.test "302 https://auth.shop.test/?rd=y 0"
    answer www.shop.test "200  0"
    answer api.shop.test_signup "405  0"
    answer hook "401"
    cat > "${tmp}/answers/facts" <<'EOF'
registered shop
alerts
kayra 0.19.0
platform traefik|running|
platform authelia|running|healthy
container shop shop-web-1|running|Up 2 minutes (healthy)
container shop shop-migrate-1|exited|Exited (0) 2 minutes ago
run shop success 20261018T000000Z-abcdef
EOF
}

run_case() {
    local name="$1" expect="$2" out rc ok
    out="$(cd "$fleet" && PATH="${tmp}/bin:${PATH}" ANSWERS="${tmp}/answers" FLEET_ROOT="$fleet" KAYRA_VERSION=0.19.0 VERIFY_WAIT=0 bash "$verify" shop 2>&1)" && rc=0 || rc=$?
    if [ "$expect" = nothing ]; then
        [ "$rc" = 0 ] && ok=1 || ok=0
    elif [ "${expect#! }" != "$expect" ]; then
        [ "$rc" = 0 ] && grep -qF -- "$expect" <<< "$out" && ok=1 || ok=0
    else
        [ "$rc" = 1 ] && grep -qF -- "✗ ${expect}" <<< "$out" && ok=1 || ok=0
    fi
    if [ "$ok" = 1 ]; then echo "ok    ${name}"; else echo "FAIL  ${name}: expected ${expect}, got:"; sed 's/^/        /' <<< "$out"; failed=1; fi
}

healthy; run_case healthy nothing
healthy; answer deploy.shop.test "403  0"
run_case authelia-without-the-rule "deploy.shop.test sends a browser to the login: HTTP 403"
healthy; answer www.shop.test "200  20"; answer issuer-www.shop.test "TRAEFIK DEFAULT CERT"
run_case traefik-default-cert "www.shop.test answers: HTTP 200, certificate by TRAEFIK DEFAULT CERT"
healthy; answer www.shop.test "502  0"
run_case app-5xx "www.shop.test answers: HTTP 502"
healthy; answer api.shop.test_signup "502  0"
run_case path-route-5xx "api.shop.test/signup answers: HTTP 502"
healthy; answer hook "202"
run_case hook-not-refused "an unsigned webhook to /hook/shop: HTTP 202, not 401"
healthy; sed -i.bak 's/^registered shop$/registered /' "${tmp}/answers/facts"
run_case not-registered "registered: nothing; server.yml says shop"
healthy; sed -i.bak 's/(healthy)$/(unhealthy)/' "${tmp}/answers/facts"
run_case unhealthy-container "shop: shop-web-1 Up 2 minutes (unhealthy)"
healthy; sed -i.bak 's/^run shop success/run shop failure/' "${tmp}/answers/facts"
run_case last-run-failed "shop: its last run failed"
healthy; sed -i.bak 's/^alerts.*$/alerts _gc/' "${tmp}/answers/facts"
run_case alert-open "open alerts: _gc"
healthy; sed -i.bak 's/^platform authelia|running|healthy$/platform authelia|exited|/' "${tmp}/answers/facts"
run_case platform-container-down "platform containers: authelia exited"
healthy; sed -i.bak '/^container shop /d; /^run shop /d' "${tmp}/answers/facts"
run_case registered-not-deployed-yet nothing
healthy; sed -i.bak '/^container shop /d' "${tmp}/answers/facts"
run_case containers-gone-after-a-run "shop: no containers"
healthy; sed -i.bak 's/^kayra .*$/kayra 0.18.0/' "${tmp}/answers/facts"
run_case older-kayra "! set up by kayra 0.18.0; the fleet pins 0.19.0 (kayra deploy shop)"
healthy; sed -i.bak 's/^kayra .*$/kayra /' "${tmp}/answers/facts"
run_case no-kayra-recorded "! set up by a kayra that recorded no version; the fleet pins 0.19.0 (kayra deploy shop)"

exit "$failed"
