#!/usr/bin/env bash
# =============================================================================
# registry-gc.sh — keep the images apps actually shipped, delete the rest.
#
# Keep set: every image referenced by the newest KEEP_RELEASES release records
# of each app (the deployer writes one per deploy), plus every image any
# container on this host uses. A registered app (its apps/<app>.json exists)
# with no release record yet is not touched — it has not deployed for the first time. An app
# that is no longer registered has all its images collected. A deleted image
# is not lost for good: resolve-images.sh --ensure
# rebuilds whatever a deploy asks for and the registry no longer has.
#
# Then: registry garbage-collect (blobs), BuildKit cache and host images older
# than a week. Runs nightly in the deployer (`kayra job <server> gc` by hand).
# =============================================================================
set -euo pipefail

KEEP_RELEASES="${KEEP_RELEASES:-10}"
REGISTRY="${REGISTRY_PUSH_HOST:-registry:5000}"
platform_dir="${PLATFORM_DIR:?}"
releases="${platform_dir}/releases"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# ── Keep set (as repo:tag, registry host stripped) ──────────────────────────
for dir in "$releases"/*/; do
    [ -d "$dir" ] || continue
    ls -1 "$dir" | sort | tail -n "$KEEP_RELEASES" | while read -r record; do
        cut -d= -f2- "${dir}${record}"
    done
done > "$work/refs"
docker ps -a --format '{{.Image}}' >> "$work/refs"
sed -E 's#^[^/]+:[0-9]+/##' "$work/refs" | sort -u > "$work/keep"
ls -1 "$releases" 2>/dev/null > "$work/released" || true
ls -1 "${platform_dir}/apps" 2>/dev/null | sed -n 's/^\(.*\)\.json$/\1/p' > "$work/registered" || true

digest() {
    curl -sfI \
        -H 'Accept: application/vnd.oci.image.index.v1+json' \
        -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
        -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
        -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
        "http://${REGISTRY}/v2/$1/manifests/$2" \
        | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: //p'
}
json_list() { jq -r ".$1 // [] | .[]"; }

# ── Delete untracked manifests ──────────────────────────────────────────────
# By digest, and never a digest a kept tag also points at: deleting a manifest
# removes every tag on it.
# Fetched into variables first: a failure inside `for x in $(...)` would not
# trip set -e, and a GC that cannot list anything looks like one with nothing
# to delete.
repos=$(curl -sf "http://${REGISTRY}/v2/_catalog?n=1000" | json_list repositories)
deleted=0
for repo in $repos; do
    app="${repo%%/*}"
    if grep -qxF "$app" "$work/registered" && ! grep -qxF "$app" "$work/released"; then
        echo "skip ${repo} (${app} has not deployed yet)"
        continue
    fi
    : > "$work/kept-digests"; : > "$work/candidates"
    tags=$(curl -sf "http://${REGISTRY}/v2/${repo}/tags/list" | json_list tags)
    for tag in $tags; do
        d=$(digest "$repo" "$tag")
        [ -n "$d" ] || continue
        if grep -qxF "${repo}:${tag}" "$work/keep"; then
            echo "$d" >> "$work/kept-digests"
        else
            echo "$tag $d" >> "$work/candidates"
        fi
    done
    while read -r tag d; do
        grep -qxF "$d" "$work/kept-digests" && continue
        curl -sf -X DELETE "http://${REGISTRY}/v2/${repo}/manifests/${d}" >/dev/null
        echo "deleted ${repo}:${tag}"
        deleted=$((deleted + 1))
    done < "$work/candidates"
done
echo "Deleted ${deleted} manifest(s)."

# ── Reclaim blobs ───────────────────────────────────────────────────────────
# garbage-collect is only safe while nothing pushes, so the registry is stopped
# for the few seconds it takes; the trap brings it back whatever happens.
if [ "$deleted" -gt 0 ]; then
    registry=$(docker ps -aq \
        --filter label=com.docker.compose.project=platform \
        --filter label=com.docker.compose.service=registry)
    image=$(docker inspect -f '{{.Config.Image}}' "$registry")
    docker stop "$registry" >/dev/null
    trap 'docker start "$registry" >/dev/null; rm -rf "$work"' EXIT
    docker run --rm --volumes-from "$registry" "$image" \
        garbage-collect /etc/docker/registry/config.yml | tail -n 3
fi

# ── Build cache and host images ─────────────────────────────────────────────
buildctl --addr tcp://buildkitd:1234 prune --keep-duration 168h | tail -n 1
docker image prune -af --filter until=168h | tail -n 1
