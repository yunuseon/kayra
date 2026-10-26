#!/usr/bin/env bash
# =============================================================================
# monitor-endpoints.sh <server> — what the server's monitor (Gatus, the
# monitor role) checks, from the same sources as verify.sh: for each server in
# its vars.yml's monitor.watch,
#   platform: auth.<domain> answers; the platform's pages (hosts.conf, status
#             where it runs a monitor) send a browser to the login; every app route answers, not 5xx;
#             deploy.<domain>/health is 200 (monitor_health_tokens.<server>);
#             with apex_redirect, the bare domain redirects (301)
#   edge:     every edge_routes name answers, not 5xx
#   nas:      nothing of its own: its stacks are monitor.extra
# plus monitor.extra as given. Every certificate must have 10 days left. Each
# name of a watched server is pinned to its inventory's address, as verify
# does, so home names resolve from wherever the monitor runs.
#
# Prints one JSON object, for ansible-playbook -e:
#   {"monitor_endpoints": [{name, group, url, conditions, redirects, health}],
#    "monitor_hosts": {"<host>": "<address>"}}
# Written for macOS's bash 3.2 too.
# =============================================================================
set -euo pipefail

KAYRA_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FLEET_ROOT="${FLEET_ROOT:?the directory of the fleet (servers/), set by kayra}"
name="${1:?Usage: monitor-endpoints.sh <server>}"
vars="${FLEET_ROOT}/servers/${name}/vars.yml"
[ -f "$vars" ] || vars=/dev/null

cert='[CERTIFICATE_EXPIRATION] > 240h'

# One endpoint as JSON: name group url redirects health condition...
endpoint() {
    local endpoint_name="$1" group="$2" url="$3" redirects="$4" health="$5"
    shift 5
    jq -cn --arg name "$endpoint_name" --arg group "$group" --arg url "$url" \
        --argjson redirects "$redirects" --argjson health "$health" '$ARGS.positional as $c |
        {name: $name, group: $group, url: $url, conditions: $c, redirects: $redirects, health: $health}' \
        --args "$@"
}

address_of() {
    local inventory="${FLEET_ROOT}/servers/$1/inventory.ini"
    [ -f "$inventory" ] || { echo "monitor: ${1} has no inventory.ini to take its address from: provision it first" >&2; exit 1; }
    awk '{for (i = 1; i <= NF; i++) if (index($i, "ansible_host=") == 1) {print substr($i, 14); exit}}' "$inventory"
}

watched() {
    local server="$1" dir="${FLEET_ROOT}/servers/$1" kind domain
    kind="$(yq -r '.kind' "${dir}/server.yml")"
    domain="$(yq -r '.domain' "${dir}/server.yml")"
    case "$kind" in
        platform)
            endpoint "auth.${domain}" "$server" "https://auth.${domain}/" false false '[STATUS] == 200' "$cert"
            monitored="$( [ -f "${dir}/vars.yml" ] && yq -r '.monitor != null' "${dir}/vars.yml" || echo false)"
            awk '!/^[[:space:]]*(#|$)/ {print $1}' "${KAYRA_ROOT}/hosts.conf" | while IFS= read -r sub; do
                [ "$sub" != status ] || [ "$monitored" = true ] || continue
                [ "$sub" = auth ] || endpoint "${sub}.${domain}" "$server" "https://${sub}.${domain}/" false false '[STATUS] == 302' "$cert"
            done
            endpoint "deploy.${domain}/health" "$server" "https://deploy.${domain}/health" false true '[STATUS] == 200'
            apex="$( [ -f "${dir}/vars.yml" ] && yq -r '.apex_redirect // ""' "${dir}/vars.yml" || true)"
            [ -z "$apex" ] || endpoint "$domain" "$server" "https://${domain}/" false false '[STATUS] == 301' "$cert"
            bash "${KAYRA_ROOT}/scripts/local/app-manifests.sh" --routes "$server" | while read -r sub path; do
                [ -z "$sub" ] || endpoint "${sub}.${domain}${path%/}" "$server" "https://${sub}.${domain}${path}" true false '[STATUS] < 500' "$cert"
            done
            ;;
        edge)
            yq -r '.edge_routes // [] | .[].subdomains[]' "${dir}/vars.yml" | while IFS= read -r sub; do
                endpoint "${sub}.${domain}" "$server" "https://${sub}.${domain}/" true false '[STATUS] < 500' "$cert"
            done
            ;;
    esac
}

# Command substitutions swallow a failure (bash 3.2 has no inherit_errexit): check first.
watch="$(yq -r '.monitor.watch // [] | .[]' "$vars")"
pinned="$(yq -r '.monitor.extra // [] | .[] | select(.server != null) | .server' "$vars")"
for server in $watch $pinned; do
    [ -f "${FLEET_ROOT}/servers/${server}/server.yml" ] || { echo "monitor: ${name} watches ${server}, which is no server of this fleet" >&2; exit 1; }
    [ -n "$(address_of "$server")" ] || { echo "monitor: ${server}'s inventory.ini names no ansible_host" >&2; exit 1; }
done

endpoints="$(
    for server in $watch; do watched "$server"; done
    yq -o json -I0 '.monitor.extra // [] | .[]' "$vars" | while IFS= read -r extra; do
        jq -c '{name, group: (.group // "extra"), url, conditions: (.conditions // ["[STATUS] == 200"]), redirects: true, health: false}' <<< "$extra"
    done
)"

# Every name a watched server answers for, pinned to its address; extras pinned by their `server`.
hosts="$(
    for server in $watch; do
        address="$(address_of "$server")"
        jq -r --arg group "$server" 'select(.group == $group) | .url' <<< "$endpoints" | sed -E 's#^https?://([^/:]+).*#\1#' | sort -u \
            | while IFS= read -r host; do jq -cn --arg host "$host" --arg address "$address" '{($host): $address}'; done
    done
    yq -o json -I0 '.monitor.extra // [] | .[] | select(.server != null)' "$vars" | while IFS= read -r extra; do
        address="$(address_of "$(jq -r .server <<< "$extra")")"
        jq -cn --arg host "$(jq -r .url <<< "$extra" | sed -E 's#^https?://([^/:]+).*#\1#')" --arg address "$address" '{($host): $address}'
    done
)"

jq -cn --argjson endpoints "$(jq -s . <<< "$endpoints")" --argjson hosts "$(jq -s 'add // {}' <<< "$hosts")" \
    '{monitor_endpoints: $endpoints, monitor_hosts: $hosts}'
