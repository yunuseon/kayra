#!/usr/bin/env bash
# Print the path of every app.yml a server runs, one per line, from the
# platform's cache of each app's repo (.cache/apps/<name>, the same clone the
# app role reads). A missing clone is
# fetched with the operator's own git credentials (kayra doctor checks them).
#
# Usage: FLEET_ROOT=<fleet> bash infrastructure/scripts/local/app-manifests.sh [--subdomains] <server-name>
#   --subdomains  print the apps' subdomains instead (for certs and /etc/hosts)
set -euo pipefail

FLEET_ROOT="${FLEET_ROOT:?the directory of the fleet (servers/), set by kayra}"
subdomains=false
[ "${1:-}" != "--subdomains" ] || { subdomains=true; shift; }
name="${1:?Usage: app-manifests.sh [--subdomains] <server-name>}"
descriptor="${FLEET_ROOT}/servers/${name}/server.yml"

yq -o json -I0 '.apps // [] | .[]' "$descriptor" | while read -r app; do
  path="$(jq -r '.path // "."' <<< "$app")"
  repo="$(jq -r '.repo' <<< "$app")"
  clone="${FLEET_ROOT}/.cache/apps/$(jq -r '.name' <<< "$app")"
  if [ ! -d "${clone}/.git" ]; then
    git clone -q --depth 1 --branch "$(jq -r '.ref // "main"' <<< "$app")" "$repo" "$clone"
  fi
  manifest="${clone}/${path}/app.yml"
  if [ "$subdomains" = true ]; then yq '.subdomains[]' "$manifest"; else echo "$manifest"; fi
done
