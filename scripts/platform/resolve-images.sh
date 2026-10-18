#!/usr/bin/env bash
# shellcheck disable=SC2154  # read_manifest assigns its variables via printf -v
# =============================================================================
# resolve-images.sh <app> <app-root> --plan | --ensure <artifact>
#
# Content-addressed image plan and build for any app. Every
# <app-root>/**/docker/image.json is an artifact, named after the directory
# that holds docker/:
#   { "image": "<app>/<name>", "dockerfile": "...", "context": "...",
#     "inputs": ["...", ...] }        all paths relative to <app-root>
#
# Two modes, because the builder has to know what it is about to do before it can
# show progress through it:
#   --plan            One TSV row per artifact: name, env var, image ref.
#                     Pure git — no registry, no daemon, no side effects.
#   --ensure <name>   Build and push that artifact if its tag is missing from
#                     the registry. Prints CACHED or BUILT.
#
# Tag = SHA of the last commit touching any declared input: same inputs, same
# content, same tag, no rebuild — on any branch.
#
# Builds go through buildkitd (BUILDKIT_HOST), never a docker daemon. Two
# registry names for the same storage:
#   REGISTRY_PUSH_HOST  registry:5000   reachable from containers (buildkit)
#   REGISTRY            localhost:5000  reachable from the host daemon (compose)
#
# Requires: git, jq; --ensure also curl and buildctl.
# =============================================================================
set -euo pipefail

app="${1:?Usage: $0 <app> <app-root> --plan | --ensure <artifact>}"
root="${2:?}"
shift 2
REGISTRY="${REGISTRY:-localhost:5000}"
REGISTRY_PUSH_HOST="${REGISTRY_PUSH_HOST:-registry:5000}"

manifests() {
    find "$root" -path '*/node_modules' -prune -o -path '*/docker/image.json' -print | sort
}

# Sets: image dockerfile context tag ref push_ref var_name
# (printf -v assigns them, which shellcheck cannot follow: see SC2154 above.)
read_manifest() {
    local manifest="$1" field
    for field in image dockerfile context; do
        printf -v "$field" '%s' "$(jq -er ".${field}" "$manifest")"
    done
    # The registry has one namespace per app; an app may only name images in its own.
    case "$image" in
        "${app}/"*) ;;
        *) echo "ERROR: ${manifest}: image ${image} is outside the ${app}/ namespace" >&2; return 1 ;;
    esac

    local inputs=() input
    while IFS= read -r input; do inputs+=("$input"); done < <(jq -r '.inputs[]' "$manifest")
    tag=$(git -C "$root" rev-list -1 HEAD -- "${inputs[@]}" | cut -c1-12)
    [ -n "$tag" ] || { echo "ERROR: ${manifest}: no commit touches its inputs" >&2; return 1; }

    ref="${REGISTRY}/${image}:${tag}"
    push_ref="${REGISTRY_PUSH_HOST}/${image}:${tag}"
    # shop/storefront -> STOREFRONT_IMAGE
    var_name="$(basename "$image" | tr '[:lower:]-' '[:upper:]_')_IMAGE"
}

artifact_name() { basename "$(dirname "$(dirname "$1")")"; }

plan() {
    local manifest
    for manifest in $(manifests); do
        read_manifest "$manifest"
        printf '%s\t%s\t%s\n' "$(artifact_name "$manifest")" "$var_name" "$ref"
    done
}

ensure() {
    local manifest
    # .../<artifact>/docker/image.json
    manifest=$(manifests | awk -F/ -v name="$1" '$(NF-2) == name')
    [ -n "$manifest" ] || { echo "ERROR: no artifact $1 under ${root}" >&2; return 1; }
    read_manifest "$manifest"

    # Every manifest type a push may leave, as registry-gc.sh asks: BuildKit
    # pushes OCI manifests, and registry:2 answers 404 to a request that does
    # not accept the type it holds — every image would look missing.
    local status
    status=$(curl -s -o /dev/null -w '%{http_code}' \
        -H 'Accept: application/vnd.oci.image.index.v1+json' \
        -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
        -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
        -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
        "http://${REGISTRY_PUSH_HOST}/v2/${image}/manifests/${tag}" || echo 000)
    if [ "$status" = "200" ]; then
        echo "CACHED ${ref}"
        return 0
    fi

    : "${BUILDKIT_HOST:?BUILDKIT_HOST is required (e.g. tcp://buildkitd:1234)}"
    echo "BUILDING ${image} -> ${push_ref}"
    buildctl build \
        --frontend dockerfile.v0 \
        --local context="${root}/${context}" \
        --local dockerfile="$(dirname "${root}/${dockerfile}")" \
        --opt filename="$(basename "$dockerfile")" \
        --output "type=image,name=${push_ref},push=true,registry.insecure=true"
    echo "BUILT ${ref}"
}

case "${1:-}" in
    --plan) plan ;;
    --ensure) ensure "${2:?--ensure needs an artifact name}" ;;
    *) echo "Usage: $0 <app> <app-root> --plan | --ensure <artifact>" >&2; exit 2 ;;
esac
