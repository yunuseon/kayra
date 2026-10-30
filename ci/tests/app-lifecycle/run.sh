#!/usr/bin/env bash
# Contract tests for the existing Compose removal and purge scripts.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/stubs"
cat > "$tmp/stubs/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CALLS"
case "$*" in
    'compose -p shop down --remove-orphans')
        test ! -e "$PLATFORM/apps/shop.json" || { echo 'registration still present' >&2; exit 92; }
        exit "${DOWN_EXIT:-0}"
        ;;
    'volume ls -q --filter label=com.docker.compose.project=shop')
        test "${LIST_EXIT:-0}" = 0 || exit "$LIST_EXIT"
        printf '%s' "${VOLUMES:-}"
        ;;
    'volume rm '*) exit "${REMOVE_EXIT:-0}" ;;
    *) echo "unexpected Docker command: $*" >&2; exit 93 ;;
esac
STUB
chmod +x "$tmp/stubs/docker"
export PATH="$tmp/stubs:$PATH"

fixture() {
    PLATFORM="$tmp/$1"
    CALLS="$PLATFORM/calls"
    export PLATFORM CALLS
    mkdir -p "$PLATFORM/bin" "$PLATFORM/apps" "$PLATFORM/app-secrets/shop" "$PLATFORM/runs/shop" "$PLATFORM/releases/shop" "$PLATFORM/data/shop" "$PLATFORM/data/other"
    cp "$root/scripts/server/app-remove" "$root/scripts/server/app-purge" "$PLATFORM/bin/"
    printf 'APPS_DIR=%s/data\n' "$PLATFORM" > "$PLATFORM/.env"
    : > "$PLATFORM/apps/shop.json"
    : > "$PLATFORM/app-secrets/shop/secret"
    : > "$PLATFORM/runs/shop/run"
    : > "$PLATFORM/releases/shop/release"
    : > "$PLATFORM/data/shop/.env"
    : > "$PLATFORM/data/other/keep"
    : > "$CALLS"
}

fixture removed
output="$(bash "$PLATFORM/bin/app-remove" shop)"
test "$output" = 'Removed shop. Its volumes are kept — app-purge shop deletes them.'
test ! -e "$PLATFORM/apps/shop.json"
test ! -e "$PLATFORM/app-secrets/shop"
test ! -e "$PLATFORM/runs/shop"
test ! -e "$PLATFORM/releases/shop"
test ! -e "$PLATFORM/data/shop"
test -e "$PLATFORM/data/other/keep"
test "$(cat "$CALLS")" = 'compose -p shop down --remove-orphans'
echo '  ✓ removal unregisters before stopping Compose, retains volumes and leaves unrelated files'

fixture stop-failure
if DOWN_EXIT=1 bash "$PLATFORM/bin/app-remove" shop > "$PLATFORM/output" 2>&1; then
    echo '  ✗ failed Compose stop succeeded' >&2
    exit 1
fi
test ! -e "$PLATFORM/apps/shop.json"
test -e "$PLATFORM/app-secrets/shop/secret"
test -e "$PLATFORM/runs/shop/run"
test -e "$PLATFORM/releases/shop/release"
test -e "$PLATFORM/data/shop/.env"
echo '  ✓ a failed Compose stop preserves records and files after unregistration'

fixture registered
if bash "$PLATFORM/bin/app-purge" shop > "$PLATFORM/output" 2>&1; then
    echo '  ✗ purging a registered app succeeded' >&2
    exit 1
fi
grep -q 'still registered' "$PLATFORM/output"
test ! -s "$CALLS"
echo '  ✓ purge refuses a registered app without invoking Docker'

fixture empty
rm "$PLATFORM/apps/shop.json"
output="$(bash "$PLATFORM/bin/app-purge" shop)"
test "$output" = 'No volumes left for shop.'
test "$(cat "$CALLS")" = 'volume ls -q --filter label=com.docker.compose.project=shop'
echo '  ✓ purge is a no-op when no volumes have the app project label'

fixture volumes
rm "$PLATFORM/apps/shop.json"
VOLUMES=$'shop_db\nshop_files\n' bash "$PLATFORM/bin/app-purge" shop
expected=$'volume ls -q --filter label=com.docker.compose.project=shop\nvolume rm shop_db shop_files'
test "$(cat "$CALLS")" = "$expected"
echo '  ✓ purge removes only volumes selected by the app project label'

fixture list-failure
rm "$PLATFORM/apps/shop.json"
if LIST_EXIT=1 bash "$PLATFORM/bin/app-purge" shop > "$PLATFORM/output" 2>&1; then
    echo '  ✗ failed volume lookup succeeded' >&2
    exit 1
fi
test "$(cat "$CALLS")" = 'volume ls -q --filter label=com.docker.compose.project=shop'
echo '  ✓ a failed volume lookup does not remove volumes'

fixture remove-failure
rm "$PLATFORM/apps/shop.json"
if VOLUMES='shop_db' REMOVE_EXIT=1 bash "$PLATFORM/bin/app-purge" shop > "$PLATFORM/output" 2>&1; then
    echo '  ✗ failed volume removal succeeded' >&2
    exit 1
fi
test "$(cat "$CALLS")" = $'volume ls -q --filter label=com.docker.compose.project=shop\nvolume rm shop_db'
echo '  ✓ a failed Docker volume removal is reported'
