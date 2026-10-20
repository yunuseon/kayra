#!/usr/bin/env bash
# Print the path of every app.yml a server runs, one per line, from the
# platform's cache of each app's repo (.cache/apps/<name>, the same clone the
# app role reads). A missing clone is
# fetched with the operator's own git credentials (kayra doctor checks them).
#
# Usage: FLEET_ROOT=<fleet> bash scripts/local/app-manifests.sh [--subdomains|--routes] <server-name>
#   --subdomains  print the apps' hosts instead, their routes' (for certs and /etc/hosts)
#   --routes      print each route as "<subdomain> <path>", / where it has none (for verify)
set -euo pipefail

FLEET_ROOT="${FLEET_ROOT:?the directory of the fleet (servers/), set by kayra}"
mode=manifests
case "${1:-}" in --subdomains) mode=subdomains; shift ;; --routes) mode=routes; shift ;; esac
name="${1:?Usage: app-manifests.sh [--subdomains|--routes] <server-name>}"
descriptor="${FLEET_ROOT}/servers/${name}/server.yml"

yq -o json -I0 '.apps // [] | .[]' "$descriptor" | while read -r app; do
  path="$(jq -r '.path // "."' <<< "$app")"
  repo="$(jq -r '.repo' <<< "$app")"
  clone="${FLEET_ROOT}/.cache/apps/$(jq -r '.name' <<< "$app")"
  if [ ! -d "${clone}/.git" ]; then
    git clone -q --depth 1 --branch "$(jq -r '.ref // "main"' <<< "$app")" "$repo" "$clone"
  fi
  manifest="${clone}/${path}/app.yml"
  case "$mode" in
    subdomains) yq '.routes // [] | map(.host) | unique | .[]' "$manifest" ;;
    routes) yq '.routes // [] | map(.host + " " + (.path // "/")) | unique | .[]' "$manifest" ;;
    *) echo "$manifest" ;;
  esac
done
