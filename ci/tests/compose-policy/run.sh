#!/usr/bin/env bash
# Runs compose-policy.sh against every case in cases/. Each case's first line
# names the violation it must produce (or "nothing"). Needs docker + jq;
# Compose runs from a pinned image so the result does not depend on the
# local Compose version, unless COMPOSE names one.
#   bash ci/tests/compose-policy/run.sh
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
policy="${here}/../../jenkins-lib/resources/platform/compose-policy.sh"
compose_image=docker:29.8.1-cli
failed=0

# COMPOSE names a local Compose binary, as the platform checks (no daemon) set it.
compose_config() {
    if [ -n "${COMPOSE:-}" ]; then
        $COMPOSE -p demo -f "$1" config --no-env-resolution --format json
    else
        docker run --rm -v "${here}/cases:/cases:ro" "$compose_image" \
            docker compose -p demo -f "/cases/$(basename "$1")" config --no-env-resolution --format json
    fi
}
for case in "${here}"/cases/*.yml; do
    expect=$(sed -n '1s/^# expect: //p' "$case")
    out=$(compose_config "$case" | bash "$policy" demo www.example.test 2>&1) && rc=0 || rc=$?
    if [ "$expect" = "nothing" ]; then
        [ "$rc" = 0 ] && ok=1 || ok=0
    else
        [ "$rc" = 1 ] && grep -qF -- "$expect" <<< "$out" && ok=1 || ok=0
    fi
    if [ "$ok" = 1 ]; then echo "ok    $(basename "$case" .yml)"; else echo "FAIL  $(basename "$case" .yml): ${out:-<no output>}"; failed=1; fi
done
exit "$failed"
