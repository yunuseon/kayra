#!/usr/bin/env bash
# Runs scripts/server/app-restore against a fixture platform directory and a
# stub docker, one case per state an app can be in after a Docker restart:
# never deployed (no release record, or none readable), running, stopped.
# Needs nothing but bash; no Docker, no server.
#   bash ci/tests/app-restore/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
restore="${here}/../../../scripts/server/app-restore"
failed=0

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "${tmp}/bin"
# docker: `ps` answers from $RUNNING or fails with $PS_EXIT; the deploy is logged and exits $CTL_EXIT.
cat > "${tmp}/bin/docker" <<'STUB'
#!/usr/bin/env bash
case "$1" in
    ps) test "${PS_EXIT:-0}" = 0 || exit "$PS_EXIT"; printf '%s' "${RUNNING:-}" ;;
    compose) echo "$*" >> "${CALLS}"; exit "${CTL_EXIT:-0}" ;;
    *) echo "unexpected docker $*" >&2; exit 99 ;;
esac
STUB
chmod +x "${tmp}/bin/docker"

sha_old="$(printf 'a%.0s' $(seq 40))"
sha_new="$(printf 'b%.0s' $(seq 40))"

# case <name> <setup> <want last line> <want exit> <want deploy call or "none">, with RUNNING/CTL_EXIT from the environment.
case_() {
    local name="$1" setup="$2" want="$3" want_code="$4" want_call="$5" platform out code calls
    platform="${tmp}/${name// /-}"
    mkdir -p "$platform"
    : > "${tmp}/calls"
    (cd "$platform" && eval "$setup")
    out="$(PATH="${tmp}/bin:${PATH}" PLATFORM_DIR="$platform" CALLS="${tmp}/calls" bash "$restore" shop 2>&1)" && code=0 || code=$?
    calls="$(cat "${tmp}/calls")"
    if [ "$(tail -1 <<< "$out")" = "$want" ] && [ "$code" = "$want_code" ] && [ "${calls:-none}" = "$want_call" ]; then
        echo "  ✓ ${name}"
    else
        echo "  ✗ ${name}: said '$(tail -1 <<< "$out")' (want '${want}'), exit ${code} (want ${want_code}), deploy '${calls:-none}' (want '${want_call}')"
        failed=1
    fi
}

case_ "no releases directory: never deployed" ":" "never deployed" 0 none
case_ "an empty releases directory: never deployed" "mkdir -p releases/shop" "never deployed" 0 none
RUNNING=0123abc case_ "running, with a release: left alone" "mkdir -p releases/shop && touch releases/shop/20261020T100000Z-${sha_new}.env" "runs" 0 none
PS_EXIT=1 case_ "failed Docker observation: no deploy" \
    "mkdir -p releases/shop && touch releases/shop/20261020T100000Z-${sha_new}.env" \
    "" 1 none
case_ "stopped: the newest release deployed again" \
    "mkdir -p releases/shop && touch releases/shop/20261018T100000Z-${sha_old}.env releases/shop/20261020T100000Z-${sha_new}.env" \
    "restored ${sha_new}" 0 "compose exec -T deployer kayra-deployer ctl deploy shop ${sha_new}"
CTL_EXIT=1 case_ "a restore whose run fails fails" \
    "mkdir -p releases/shop && touch releases/shop/20261020T100000Z-${sha_new}.env" \
    "" 1 "compose exec -T deployer kayra-deployer ctl deploy shop ${sha_new}"

exit "$failed"
