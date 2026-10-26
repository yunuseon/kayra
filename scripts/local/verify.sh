#!/usr/bin/env bash
# =============================================================================
# verify.sh <server> — is a platform server working, as its users see it?
# Run by `kayra verify` and at the end of `kayra deploy` / `kayra up`.
#
# From here, the way the world reaches it (each name pinned to the server's
# address, so neither DNS nor /etc/hosts has to be in place yet):
#   - auth.<domain> answers; the platform's own pages (hosts.conf; status only
#     where a monitor runs) send a browser to the login, not a 403 from rules
#     Authelia never loaded
#   - with apex_redirect, the bare domain redirects permanently to that host,
#     path and query kept
#   - every certificate is a real one (Let's Encrypt or mkcert), never
#     Traefik's default
#   - an unsigned webhook is refused (with webhooks: false, /hook is not
#     served at all); every app route answers, not 5xx
# On the server (one SSH call):
#   - every app in server.yml is registered, and nothing else
#   - every app's containers run, none unhealthy; its last run did not fail
#   - every platform container runs, none unhealthy; no alert is open
#   - which kayra set it up (/opt/kayra/version): one that is not this kayra
#     (KAYRA_VERSION, the fleet's pin) is noted, not failed — it still works,
#     and every server runs the last release until its rollout reaches it
#
# Certificates and routes can lag a fresh deploy (ACME, DNS-01's minute), so
# the probes retry for VERIFY_WAIT seconds (default 150) before failing.
# Written for macOS's bash 3.2 too.
# =============================================================================
set -euo pipefail

KAYRA_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FLEET_ROOT="${FLEET_ROOT:?the directory of the fleet (servers/), set by kayra}"
pin="${KAYRA_VERSION:?the kayra that runs, set by kayra}"
name="${1:?Usage: verify.sh <server>}"
dir="${FLEET_ROOT}/servers/${name}"
wait="${VERIFY_WAIT:-150}"
failed=0

fail() { echo "    ✗ $*"; failed=1; }
pass() { echo "    ✓ $*"; }
note() { echo "    ! $*"; }

domain="$(yq -r '.domain' "${dir}/server.yml")"
# Not yq's `//`: it takes false for missing too.
webhooks="$( { [ -f "${dir}/vars.yml" ] && yq -r '.webhooks' "${dir}/vars.yml"; } || echo true)"
apex="$( { [ -f "${dir}/vars.yml" ] && yq -r '.apex_redirect // ""' "${dir}/vars.yml"; } || true)"
inventory="${dir}/inventory.ini"
[ -f "$inventory" ] || { fail "no inventory for ${name}: provision it first"; exit 1; }
field() { awk -v key="$1" '{for (i = 1; i <= NF; i++) if (index($i, key "=") == 1) {print substr($i, length(key) + 2); exit}}' "$inventory"; }
address="$(field ansible_host)"
port="$(field ansible_port)"
user="$(field ansible_user)"
key="$(field ansible_ssh_private_key_file)"
registered_wanted="$(yq -r '.apps // [] | .[].name' "${dir}/server.yml")"

# ── From outside ────────────────────────────────────────────────────────────
# "<status> <redirect> <verify result> <issuer CN>" for a host (and path), pinned to the server.
probe() {
    local host="$1" method="${2:-GET}" path="${3:-/}" result issuer
    result="$(curl -s -o /dev/null -m 10 -X "$method" -H 'Accept: text/html' \
        --resolve "${host}:443:${address}" -w '%{http_code} %{redirect_url} %{ssl_verify_result}' \
        "https://${host}${path}" 2>/dev/null || echo "000 - -")"
    issuer="$(openssl s_client -connect "${address}:443" -servername "$host" </dev/null 2>/dev/null \
        | openssl x509 -noout -issuer 2>/dev/null | sed -n 's/.*CN *= *//p')"
    echo "${result} ${issuer:-none}"
}

# Probes until `test` accepts the answer or VERIFY_WAIT runs out; prints the last answer.
until_ok() {
    local host="$1" method="$2" test="$3" path="${4:-/}" deadline answer
    deadline=$(( $(date +%s) + wait ))
    while :; do
        answer="$(probe "$host" "$method" "$path")"
        if "$test" "$answer"; then echo "$answer"; return 0; fi
        [ "$(date +%s)" -lt "$deadline" ] || { echo "$answer"; return 1; }
        sleep 10
    done
}

real_cert() { case "$1" in *"TRAEFIK DEFAULT CERT"|*" none") return 1 ;; esac; [ "$(cut -d' ' -f3 <<< "$1")" = 0 ]; }
answers() { real_cert "$1" && [ "$(cut -d' ' -f1 <<< "$1")" = 200 ]; }
to_login() { real_cert "$1" && [ "$(cut -d' ' -f1 <<< "$1")" = 302 ] && case "$(cut -d' ' -f2 <<< "$1")" in "https://auth.${domain}/"*) return 0 ;; esac; return 1; }
not_5xx() { real_cert "$1" && case "$(cut -d' ' -f1 <<< "$1")" in 000|5*) return 1 ;; esac; }
refused() { real_cert "$1" && [ "$(cut -d' ' -f1 <<< "$1")" = 401 ]; }
to_apex() { real_cert "$1" && [ "$(cut -d' ' -f1 <<< "$1")" = 301 ] && [ "$(cut -d' ' -f2 <<< "$1")" = "https://${apex}.${domain}/x?y" ]; }

describe() { echo "HTTP $(cut -d' ' -f1 <<< "$1"), certificate by $(cut -d' ' -f4- <<< "$1") (verify $(cut -d' ' -f3 <<< "$1"))"; }

check() {
    local label="$1" host="$2" method="$3" test="$4" path="${5:-/}" answer
    if answer="$(until_ok "$host" "$method" "$test" "$path")"; then pass "$label"; else fail "${label}: $(describe "$answer")"; fi
}

check "auth.${domain} answers" "auth.${domain}" GET answers
monitored="$( [ -f "${dir}/vars.yml" ] && yq -r '.monitor != null' "${dir}/vars.yml" || echo false)"
while IFS= read -r sub; do
    case "$sub" in
        auth) ;;
        status) [ "$monitored" != true ] || check "${sub}.${domain} sends a browser to the login" "${sub}.${domain}" GET to_login ;;
        *) check "${sub}.${domain} sends a browser to the login" "${sub}.${domain}" GET to_login ;;
    esac
done < <(awk '!/^[[:space:]]*(#|$)/ {print $1}' "${KAYRA_ROOT}/hosts.conf")
[ -z "$apex" ] || check "${domain} redirects to ${apex}.${domain}" "$domain" GET to_apex "/x?y"

first_app="$(head -1 <<< "$registered_wanted")"
if [ -n "$first_app" ]; then
    hook() {
        curl -s -o /dev/null -m 10 -X POST --resolve "deploy.${domain}:443:${address}" \
            -w '%{http_code}' "https://deploy.${domain}/hook/${first_app}" 2>/dev/null || echo 000
    }
    code="$(hook)"
    if [ "$webhooks" = false ]; then
        [ "$code" = 404 ] && pass "webhooks are off: /hook is not served" || fail "webhooks: false, yet /hook/${first_app} answers HTTP ${code}, not 404"
    else
        [ "$code" = 401 ] && pass "an unsigned webhook is refused" || fail "an unsigned webhook to /hook/${first_app}: HTTP ${code}, not 401"
    fi
    while read -r sub path; do
        [ -z "$sub" ] || check "${sub}.${domain}${path%/} answers" "${sub}.${domain}" GET not_5xx "$path"
    done < <(bash "${KAYRA_ROOT}/scripts/local/app-manifests.sh" --routes "$name")
fi

# ── On the server ───────────────────────────────────────────────────────────
facts="$(ssh -p "${port:-22}" -i "$key" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    "${user}@${address}" 'set -e
cd /opt/platform
echo "registered $(ls apps 2>/dev/null | sed -n "s/\.json$//p" | sort | tr "\n" " ")"
echo "alerts $(ls alerts 2>/dev/null | tr "\n" " ")"
echo "kayra $(cat /opt/kayra/version 2>/dev/null || true)"
docker compose ps -a --format "{{.Service}}|{{.State}}|{{.Health}}" | sed "s/^/platform /"
for app in $(ls apps 2>/dev/null | sed -n "s/\.json$//p"); do
    docker ps -a --filter "label=com.docker.compose.project=$app" --format "{{.Names}}|{{.State}}|{{.Status}}" | sed "s/^/container $app /"
    last=$(ls runs/$app 2>/dev/null | sort | tail -1)
    [ -z "$last" ] || echo "run $app $(sed -n "s/.*\"state\":\"\([a-z]*\)\".*/\1/p" runs/$app/$last/meta.json) $last"
done' 2>&1)" || { fail "the server answers over SSH: ${facts}"; exit 1; }

wanted="$(sort <<< "$registered_wanted" | tr '\n' ' ')"
have="$(sed -n 's/^registered //p' <<< "$facts")"
wanted="$(xargs <<< "$wanted")"
have="$(xargs <<< "$have")"
[ "$wanted" = "$have" ] && pass "registered: ${have:-no apps}" \
    || fail "registered: ${have:-nothing}; server.yml says ${wanted:-no apps} (kayra apps ${name})"

running="$(sed -n 's/^kayra //p' <<< "$facts" | xargs)"
if [ "$running" = "$pin" ]; then pass "set up by kayra ${pin}, the fleet's pin"
elif [ -z "$running" ]; then note "set up by a kayra that recorded no version; the fleet pins ${pin} (kayra deploy ${name})"
else note "set up by kayra ${running}; the fleet pins ${pin} (kayra deploy ${name})"; fi

alerts="$(sed -n 's/^alerts //p' <<< "$facts" | xargs)"
[ -z "$alerts" ] && pass "no alert is open" || fail "open alerts: ${alerts}"

bad_platform="$(sed -n 's/^platform //p' <<< "$facts" | awk -F'|' '$2 != "running" || $3 == "unhealthy" || $3 == "starting" {print $1 " " $2 " " $3}')"
[ -z "$bad_platform" ] && pass "every platform container runs" || fail "platform containers: $(paste -sd',' - <<< "$bad_platform")"

while IFS= read -r app; do
    [ -n "$app" ] || continue
    containers="$(sed -n "s/^container ${app} //p" <<< "$facts")"
    run="$(sed -n "s/^run ${app} //p" <<< "$facts")"
    # One-shot containers (an init, a migration) exit 0 and stay exited.
    bad="$(awk -F'|' '$2 != "running" && $3 !~ /^Exited \(0\)/ || $3 ~ /unhealthy|health: starting/ {print $1 " " $3}' <<< "$containers")"
    # Registered and never run: waiting for its first push, not broken.
    if [ -z "$containers" ] && [ -z "$run" ]; then pass "${app}: not deployed yet"; continue
    elif [ -z "$containers" ]; then fail "${app}: no containers"
    elif [ -n "$bad" ]; then fail "${app}: $(paste -sd',' - <<< "$bad")"
    else pass "${app}: $(grep -c . <<< "$containers") container(s) up"; fi
    case "$run" in
        failure*) fail "${app}: its last run failed ($(cut -d' ' -f2 <<< "$run"): kayra app logs ${name} ${app})" ;;
        "") pass "${app}: no runs yet" ;;
        *) pass "${app}: last run $(cut -d' ' -f1 <<< "$run")" ;;
    esac
done <<< "$registered_wanted"

exit "$failed"
