#!/usr/bin/env bash
# Runs every case in `cases` through kayra against the fixture fleet, and
# writes what each one did to <out>/<case>:
# every invocation of ansible*, tofu, ssh and the local scripts, as JSON lines
# (argv, plus ANSIBLE_* for ansible and FLEET_ROOT where set), then its stdout
# and exit status. Stubs
# stand in for all of them, so nothing outside a temp dir is touched; queries
# (tofu state/output, yq, app-manifests.sh) run or answer as on a real fleet.
#
# expected/ was first recorded from the justfiles kayra replaced, and proved
# them equal. Since they are gone it is kayra's record: re-record a case only
# for a change meant to alter what it does, and review the diff.
#
# Usage: record.sh <out-dir>
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
infrastructure="$(cd "${here}/../../.." && pwd)"
out="${1:?Usage: record.sh <out-dir>}"
real_bash="$(command -v bash)"

tmp="$(mktemp -d)"
tmp="$(cd -P "$tmp" && pwd)"
trap 'rm -rf "$tmp"' EXIT

# The fleet in a directory of its own, the engine where it is: two roots.
fleet="${tmp}/fleet"
mkdir -p "$fleet" "${tmp}/bin"
cp -R "${here}/fleet/." "$fleet/"
mkdir -p "${fleet}/.cache/apps/shop/.git"
cp "${here}/fleet/shop.app.yml" "${fleet}/.cache/apps/shop/app.yml"
for server in shop-test shop-prod; do touch "${fleet}/servers/${server}/terraform/provisioned"; done

stub() {
    {
        echo "#!${real_bash}"
        # shellcheck disable=SC2016
        echo 'record() { jq -cSn --arg prog "$(basename "$0")" '"'"'{argv: ([$prog] + $ARGS.positional)} + (if $prog | startswith("ansible") then {env: ($ENV | with_entries(select(.key | startswith("ANSIBLE_"))))} elif $ENV.FLEET_ROOT then {env: {FLEET_ROOT: $ENV.FLEET_ROOT}} else {} end)'"'"' --args -- "$@" >> "$TRACE"; }'
        cat
    } > "${tmp}/bin/$1"
    chmod +x "${tmp}/bin/$1"
}
for program in ansible ansible-playbook ansible-galaxy ssh docker; do echo 'record "$@"' | stub "$program"; done
stub tofu <<'STUB'
chdir="${1#-chdir=}"
case "${2:-}" in
    state) [ ! -f "${chdir}/provisioned" ] || echo hcloud_server.this; exit 0 ;;
    output) [ -f "${chdir}/provisioned" ] && echo 203.0.113.10; exit ;;
esac
record "$@"
STUB
stub bash <<STUB
case "\${1:-}" in
    */scripts/local/require-main.sh|*/scripts/local/require-latest-state.sh|*/scripts/local/home-reach.sh|*/scripts/local/certs.sh|*/scripts/local/home-image.sh|*/scripts/local/setup-hosts.sh|*/scripts/local/app-check.sh|*/scripts/local/verify.sh)
        record "\$@"; exit 0 ;;
esac
exec "${real_bash}" "\$@"
STUB

mkdir -p "$out"
out="$(cd "$out" && pwd)"
# Only what the commands set may reach the trace, not the caller's ANSIBLE_*.
while read -r variable; do unset "$variable"; done < <(compgen -e | grep '^ANSIBLE_' || true)
grep -v '^#' "${here}/cases" | while IFS='|' read -r case stdin arguments; do
    case="$(echo "$case" | xargs)"
    stdin="$(echo "$stdin" | xargs)"
    export TRACE="${out}/${case}"
    : > "$TRACE"
    read -ra words <<< "$arguments"
    command=(node "${infrastructure}/cli/src/main.ts" "${words[@]}")
    status=0
    stdout="$(cd "$fleet" && echo "$stdin" | PATH="${tmp}/bin:${PATH}" "${command[@]}" 2>/dev/null)" || status=$?
    { echo "--- stdout"; [ -z "$stdout" ] || echo "$stdout"; echo "--- exit ${status}"; } >> "$TRACE"
    sed -i.bak -e "s|${infrastructure}|<kayra>|g" -e "s|${fleet}|<fleet>|g" -e "s|${HOME}|~|g" "$TRACE"
    rm "${TRACE}.bak"
done
