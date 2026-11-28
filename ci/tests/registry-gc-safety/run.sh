#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/platform/managed-apps" "$fixture/stubs"
for command in docker curl; do
    cat > "$fixture/stubs/$command" <<'STUB'
#!/usr/bin/env bash
echo "unexpected effect" >> "$CALLS"
exit 99
STUB
    chmod +x "$fixture/stubs/$command"
done
export CALLS="$fixture/calls"
export PATH="$fixture/stubs:$PATH" PLATFORM_DIR="$fixture/platform"
refused() {
    if KAYRA_MANAGED_ROLLOUTS="$1" bash "$root/scripts/platform/registry-gc.sh" > "$fixture/output" 2>&1; then
        echo 'GC accepted managed ownership or enablement' >&2
        exit 1
    fi
    grep -q "$2" "$fixture/output"
    test ! -e "$CALLS"
}

refused true 'recovery image pins require pin-aware GC'
touch "$fixture/platform/managed-apps/owned.json"
refused false 'recovery image pins require pin-aware GC'
cat > "$fixture/stubs/find" <<'STUB'
#!/usr/bin/env bash
exit 1
STUB
chmod +x "$fixture/stubs/find"
refused false 'ownership state is unreadable'
echo '  ✓ registry GC refuses managed enablement, ownership and unreadable state before any effect'
