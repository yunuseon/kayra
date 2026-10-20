#!/usr/bin/env bash
# =============================================================================
# app-check.sh <app-root> — what the platform checks when it deploys an app,
# checked in the app's own repository, before a push: run by `kayra app
# check`, which has checked app.yml against its schema first.
#
#   - app.yml's compose files exist, inside the app; its routes' hosts are
#     not the platform's (hosts.conf)
#   - every docker/image.json: its image in the app's namespace, a commit
#     touching its inputs (resolve-images.sh --plan, as the builder runs it)
#   - the compose config those files resolve to passes the compose policy
#     (compose-policy.sh, as the deployer runs it: no Traefik label, no
#     platform network, each route to one of its services), with placeholder
#     values for the images, config and secrets, and hosts under example.test
#
# Needs git, jq, yq and the docker CLI with Compose (no daemon: `compose
# config` only reads files). Written for macOS's bash 3.2 too: no mapfile.
# =============================================================================
set -euo pipefail

KAYRA_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
root="$(cd "${1:?Usage: app-check.sh <app-root>}" && pwd)"
manifest="${root}/app.yml"
domain=example.test
failed=0

fail() { echo "✗ $*"; failed=1; }
pass() { echo "✓ $*"; }

name="$(yq -r '.name' "$manifest")"
files="$(yq -r '.compose[]' "$manifest")"
routes="$(yq -o=json -I0 '.routes // []' "$manifest")"
subdomains="$(yq -r '.routes // [] | map(.host) | unique | .[]' "$manifest")"
reserved="$(awk '!/^[[:space:]]*(#|$)/ {print $1}' "${KAYRA_ROOT}/hosts.conf")"

# ── app.yml ─────────────────────────────────────────────────────────────────
while IFS= read -r file; do
    case "$file" in
        /*|..|../*|*/../*|*/..) fail "compose file ${file} is outside the app" ;;
        *) [ -f "${root}/${file}" ] || fail "compose file ${file} does not exist" ;;
    esac
done <<< "$files"
while IFS= read -r sub; do
    if [ -n "$sub" ] && grep -qxF -- "$sub" <<< "$reserved"; then fail "route host ${sub} is the platform's"; fi
done <<< "$subdomains"
described="$(yq -r '.routes // [] | map(.host + (.path // "") + " → " + .service + ":" + (.port | tostring)) | join(", ")' "$manifest")"
[ "$failed" = 0 ] && pass "app.yml: compose $(paste -sd' ' - <<< "$files") · routes ${described:-none}"

# ── Images ──────────────────────────────────────────────────────────────────
if plan="$(bash "${KAYRA_ROOT}/scripts/platform/resolve-images.sh" "$name" "$root" --plan)"; then
    pass "images: $(awk -F'\t' '{printf "%s%s", sep, $1; sep=", "}' <<< "$plan")"
else
    fail "images: resolve-images.sh refused the image plan (above)"
fi
[ "$failed" = 0 ] || exit 1

# ── Compose policy ──────────────────────────────────────────────────────────
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
{
    echo "COMPOSE_PROJECT_NAME=${name}"
    echo "DOMAIN=${domain}"
    yq -r '.config // [] | .[] | . + "=check"' "$manifest"
    awk -F'\t' 'NF == 3 {print $2 "=" $3}' <<< "$plan"
} > "${work}/.env"
# Secrets reach compose as the deploy's environment, never through a file.
while IFS= read -r key; do
    [ -z "$key" ] || export "${key}=check"
done <<< "$(yq -r '.secrets // [] | .[]' "$manifest")"

set -- docker compose -p "$name" --project-directory "$root" --env-file "${work}/.env"
while IFS= read -r file; do set -- "$@" -f "${root}/${file}"; done <<< "$files"
"$@" config --no-env-resolution --format json > "${work}/config.json" \
    || { fail "compose: docker compose config failed (above)"; exit 1; }

set --
while IFS= read -r sub; do [ -z "$sub" ] || set -- "$@" "${sub}.${domain}"; done <<< "$subdomains"
if violations="$(bash "${KAYRA_ROOT}/scripts/platform/compose-policy.sh" "$name" "$domain" "$routes" "$@" < "${work}/config.json")"; then
    pass "compose policy: admitted"
else
    while IFS= read -r line; do fail "compose policy: ${line}"; done <<< "$violations"
fi
exit "$failed"
