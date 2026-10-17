#!/usr/bin/env bash
# Refuse to change a real server from anything but main as merged.
#
# Every kayra command deploys the local checkout, whatever it is. A
# test server may track a branch (that is how platform changes are tested);
# every other server is only ever changed from a clean main that matches
# origin/main, so what runs there is exactly what was reviewed and merged.
# Uncommitted changes in other servers' folders do not count: a test server's
# branch pointers must not block a prod deploy. The kayra that runs must be the
# release the fleet pins, not a linked checkout: everything the server runs,
# its deploy pipeline included, is copied from it.
#
# Usage: FLEET_ROOT=<fleet> bash scripts/local/require-main.sh <server-name>
set -euo pipefail

FLEET_ROOT="${FLEET_ROOT:?the directory of the fleet (servers/), set by kayra}"
name="${1:?Usage: require-main.sh <server-name>}"
target="$(yq '.target' "${FLEET_ROOT}/servers/${name}/server.yml")"
[ "$target" != "multipass" ] || exit 0

fail() {
    echo "ERROR: ${name} is a ${target} server and is only changed from main as merged." >&2
    echo "  $*" >&2
    exit 1
}

cd "$FLEET_ROOT"
[ ! -L node_modules/@yunuseon/kayra ] \
    || fail "node_modules/@yunuseon/kayra is a linked checkout. Release it, bump package.json, then: npm ci"
branch="$(git branch --show-current)"
[ "$branch" = "main" ] || fail "The checkout is on '${branch:-a detached HEAD}'. Merge it, then: git switch main && git pull"
git fetch -q origin main || fail "Could not fetch origin/main to compare against."
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] \
    || fail "Local main differs from origin/main. Pull, and send unpushed commits through a PR."

others=()
for dir in servers/*/; do
    [ "$dir" = "servers/${name}/" ] || others+=(":(exclude)${dir}")
done
dirty="$(git status --porcelain --untracked-files=no -- . ${others[@]+"${others[@]}"})"
[ -z "$dirty" ] || fail "Uncommitted changes would be deployed; commit them through a PR first:
${dirty}"
