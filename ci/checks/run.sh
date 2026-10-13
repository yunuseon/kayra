#!/usr/bin/env bash
# =============================================================================
# The checks, in two parts that run apart once the engine has its own repo:
#   --platform      the engine's own files (KAYRA_ROOT)
#   --fleet <dir>   a fleet (the directory holding servers/) against it
# Runs inside the checks image (see Dockerfile next to it). Every check runs;
# the exit status says whether any failed.
#
# The rules turn rules from CLAUDE.md into greps. A rule checked here says so
# in CLAUDE.md; one that is not stays prose on purpose.
# =============================================================================
# No pipefail: the rules pipe greps that find nothing, which is the good case.
set -u
KAYRA_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
platform=false
FLEET_ROOT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --platform) platform=true; shift ;;
        --fleet) FLEET_ROOT="$(cd "${2:?--fleet needs the directory holding servers/}" && pwd)" || exit 1; shift 2 ;;
        *) echo "usage: run.sh [--platform] [--fleet <dir>]" >&2; exit 2 ;;
    esac
done
if [ "$platform" = false ] && [ -z "$FLEET_ROOT" ]; then
    echo "usage: run.sh [--platform] [--fleet <dir>]" >&2; exit 2
fi
E="$KAYRA_ROOT"
F="$FLEET_ROOT"

failed=()
check() {
    local name="$1"; shift
    echo "::: ${name}"
    if "$@"; then echo "ok   ${name}"; else echo "FAIL ${name}"; failed+=("$name"); fi
}

# Prints the offending lines and fails if a rule's grep found any.
none() {
    local found
    found=$(cat)
    [ -z "$found" ] && return 0
    echo "$found"
    return 1
}

# Vault-encrypted files are not YAML; nothing can read them without the key.
vaulted() { head -c 14 "$1" | grep -q '^\$ANSIBLE_VAULT'; }

# The fleet's files: everything under it but the engine, which may live inside
# it (a fleet repo that still carries a copy) or anywhere else.
fleet_find() {
    find "$F" \( -path "$E" -o -path '*/node_modules' -o -path "$F/.git" -o -path "$F/.cache" \) -prune -o "$@" -print
}

# Reads paths, prints those that are not vaults.
not_vaulted() { local f; while IFS= read -r f; do vaulted "$f" || echo "$f"; done; }

# The compose files the engine deploys, and the fleet's stacks (apps' own are
# admitted at deploy, from their repos).
engine_compose_files() {
    echo "$E/compose/docker-compose.yml"
    echo "$E/compose/docker-compose.ci.yml"
    echo "$E/ansible/roles/edge-proxy/files/docker-compose.yml"
    echo "$E/ansible/roles/restic-backup/files/docker-compose.yml"
    echo "$E/ansible/roles/restic-backup/files/docker-compose.postgres.yml"
}
fleet_compose_files() { ls "$F"/servers/*/stacks/*/compose.yaml 2>/dev/null; }

# "Every version is pinned exactly": no missing, floating or major-only tag.
# Reads `file|image` lines. ${VAR} images are set by the platform at deploy.
unpinned() {
    awk -F'|' '$2 != "" && $2 !~ /\$\{/ && $2 !~ /@sha256:/ {
        n = split($2, part, ":"); tag = (n > 1 && part[n] !~ /\//) ? part[n] : ""
        if (tag == "" || tag ~ /^(latest|lts|stable)/ || tag ~ /^v?[0-9]+(-[a-z].*)?$/)
            print $1 ": " $2 " is not pinned to an exact version"
      }'
}
compose_images() { local f; for f in "$@"; do yq '.services[].image // ""' "$f" | sed "s#^#${f}|#"; done; }

# A key in the repo is a key published: vault it or keep it out (gitignored).
private_keys() { grep -lE -e '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----' "$@" | sed 's/$/: holds a private key/'; }

# --- the platform (the engine) ---------------------------------------------------

platform_shell() {
    local files
    mapfile -t files < <(find "$E" -path '*/node_modules' -prune -o -name '*.sh' -print; find "$E/scripts/server" -type f)
    shellcheck --severity=warning "${files[@]}"
}

platform_yaml() {
    local files
    mapfile -t files < <(find "$E" -path '*/node_modules' -prune -o \( -name '*.yml' -o -name '*.yaml' \) -print | not_vaulted)
    yamllint --strict -c "$E/ci/checks/yamllint.yml" "${files[@]}"
}

platform_ansible() { (cd "$E/ansible" && ansible-lint --offline playbooks roles); }

platform_tofu_fmt() { tofu fmt -check -recursive -diff "$E/terraform"; }

compose_policy() { COMPOSE=docker-compose bash "$E/ci/tests/compose-policy/run.sh"; }

# The kayra CLI: strictest types, its lint rules, its tests.
cli_typecheck() { (cd "$E" && node_modules/.bin/tsc -p cli --noEmit); }
cli_lint() { (cd "$E/cli" && ../node_modules/.bin/eslint --flag unstable_native_nodejs_ts_config .); }
cli_test() { (cd "$E" && node --test 'cli/test/**/*.test.ts'); }

# "Never tls=true on a deployed router": ACME never runs for it.
rule_platform_no_tls_true() {
    local files
    mapfile -t files < <(engine_compose_files)
    grep -Hn 'tls=true' "${files[@]}" | none
}

# "Never mount /var/run/docker.sock into jenkins-agent."
rule_agent_has_no_socket() {
    yq '.services.jenkins-agent.volumes // [] | .[]' "$E/compose/docker-compose.ci.yml" \
        | grep docker.sock | sed 's/^/jenkins-agent mounts /' | none
}

# "Never add docker back to the agent's JCasC label."
rule_agent_label_has_no_docker() {
    yq '.jenkins.nodes[].permanent.labelString' "$E/compose/jenkins/casc/00-platform.yaml" \
        | grep -w docker | sed 's/^/agent label: /' | none
}

# "Never export COMPOSE_PROJECT_NAME on the controller."
rule_controller_has_no_project_name() {
    yq '.services.jenkins-controller.environment // [] | .[]' "$E/compose/docker-compose.ci.yml" \
        | grep COMPOSE_PROJECT_NAME | sed 's/^/jenkins-controller sets /' | none
}

rule_platform_images_are_pinned() {
    local files
    mapfile -t files < <(engine_compose_files)
    {
        compose_images "${files[@]}"
        find "$E" -name 'Dockerfile*' -not -name '*.dockerignore' -exec grep -HiE '^FROM ' {} + \
            | grep -viE ' AS (checks)$|^[^:]+:FROM (tools|scratch)( |$)' \
            | sed -E 's/[[:space:]]+AS[[:space:]]+[^[:space:]]+$//I; s/^([^:]+):FROM[[:space:]]+/\1|/I'
    } | unpinned | none
}

rule_platform_no_private_keys() {
    local files
    mapfile -t files < <(find "$E" -path '*/node_modules' -prune -o -type f -print)
    private_keys "${files[@]}" | none
}

# --- the fleet, against the engine ------------------------------------------------

fleet_shell() {
    local files
    mapfile -t files < <(fleet_find -name '*.sh')
    [ "${#files[@]}" -eq 0 ] || shellcheck --severity=warning "${files[@]}"
}

fleet_yaml() {
    local files
    mapfile -t files < <(fleet_find \( -name '*.yml' -o -name '*.yaml' \) | not_vaulted)
    yamllint --strict -c "$E/ci/checks/yamllint.yml" "${files[@]}"
}

fleet_tofu_dirs() { ls -d "$F"/servers/*/terraform "$F"/dns/terraform 2>/dev/null; }

fleet_tofu_fmt() {
    local dirs
    mapfile -t dirs < <(fleet_tofu_dirs)
    tofu fmt -check -recursive -diff "${dirs[@]}"
}

# The providers come from GitHub's release downloads, which fail now and then
# (504s): a few tries before the check does. TF_PLUGIN_CACHE_DIR (a cache
# mount, see the Dockerfile) keeps them between runs.
tofu_init() {
    local try
    for try in 1 2 3; do
        tofu init -backend=false -input=false -no-color >/dev/null && return 0
        [ "$try" = 3 ] || sleep 10
    done
    return 1
}

# Validates the engine's modules too, as the fleet uses them.
fleet_tofu_validate() {
    local dir ok=0
    for dir in $(fleet_tofu_dirs); do
        echo "  ${dir#"$F"/}"
        (cd "$dir" && tofu_init && tofu validate -no-color) || ok=1
    done
    return "$ok"
}

# The fleet against the engine's schemas and cross-checks (kayra validate):
# without the vault password or the apps' clones, what needs them is noted
# as not checked, never failed.
fleet_kayra_validate() { (cd "$F" && node "$E/cli/src/main.ts" validate); }

rule_fleet_no_tls_true() {
    local files
    mapfile -t files < <(fleet_compose_files)
    [ "${#files[@]}" -eq 0 ] || grep -Hn 'tls=true' "${files[@]}" | none
}

# "No app a fleet registers is named in the engine, apart from comments."
# Every app any server runs, wherever its code lives.
rule_platform_names_no_app() {
    local app
    for app in $(yq -N '.apps // [] | .[].name' "$F"/servers/*/server.yml | sort -u); do
        grep -rnw --exclude-dir=node_modules "$app" "$E" \
            | grep -vE '^[^:]+:[0-9]+:[[:space:]]*(#|//|<!--)'
    done | none
}

rule_fleet_images_are_pinned() {
    local files
    mapfile -t files < <(fleet_compose_files)
    [ "${#files[@]}" -eq 0 ] || compose_images "${files[@]}" | unpinned | none
}

rule_fleet_no_private_keys() {
    local files
    mapfile -t files < <(fleet_find -type f)
    private_keys "${files[@]}" | none
}

if [ "$platform" = true ]; then
    check platform:shellcheck platform_shell
    check platform:yamllint platform_yaml
    check platform:ansible-lint platform_ansible
    check platform:tofu-fmt platform_tofu_fmt
    check platform:compose-policy compose_policy
    check platform:cli-typecheck cli_typecheck
    check platform:cli-lint cli_lint
    check platform:cli-test cli_test
    check platform:rule:no-tls-true rule_platform_no_tls_true
    check platform:rule:agent-has-no-socket rule_agent_has_no_socket
    check platform:rule:agent-label-has-no-docker rule_agent_label_has_no_docker
    check platform:rule:controller-has-no-project-name rule_controller_has_no_project_name
    check platform:rule:images-are-pinned rule_platform_images_are_pinned
    check platform:rule:no-private-keys rule_platform_no_private_keys
fi
if [ -n "$F" ]; then
    check fleet:shellcheck fleet_shell
    check fleet:yamllint fleet_yaml
    check fleet:tofu-fmt fleet_tofu_fmt
    check fleet:tofu-validate fleet_tofu_validate
    check fleet:kayra-validate fleet_kayra_validate
    check fleet:rule:no-tls-true rule_fleet_no_tls_true
    check fleet:rule:platform-names-no-app rule_platform_names_no_app
    check fleet:rule:images-are-pinned rule_fleet_images_are_pinned
    check fleet:rule:no-private-keys rule_fleet_no_private_keys
fi

echo
if [ "${#failed[@]}" -gt 0 ]; then
    echo "Failed: ${failed[*]}"
    exit 1
fi
echo "All checks passed."
