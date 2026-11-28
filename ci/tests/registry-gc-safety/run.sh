#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/platform/managed-apps" "$fixture/stubs"
touch "$fixture/platform/managed-apps/owned.json"
for command in docker curl; do
    cat > "$fixture/stubs/$command" <<'STUB'
#!/usr/bin/env bash
echo "unexpected effect" >> "$CALLS"
exit 99
STUB
    chmod +x "$fixture/stubs/$command"
done
export CALLS="$fixture/calls"
if PATH="$fixture/stubs:$PATH" PLATFORM_DIR="$fixture/platform" bash "$root/scripts/platform/registry-gc.sh" > "$fixture/output" 2>&1; then
    echo 'GC accepted coordinator-managed apps' >&2
    exit 1
fi
grep -q 'recovery image pins require pin-aware GC' "$fixture/output"
test ! -e "$CALLS"
echo '  ✓ registry GC refuses coordinator-managed apps before querying Docker or the registry'
