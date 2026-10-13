#!/usr/bin/env bash
# Refuse to run OpenTofu on a state that an unmerged branch has moved past.
#
# The fleet commits its (encrypted) states, each change through a PR. Until
# that PR is merged, main holds the state from before: an apply from there
# would work from a stale state. The envelope keeps lineage and serial in
# plaintext, so a newer state is one with the same lineage and a higher
# serial on any branch of origin.
#
# Usage: require-latest-state.sh <terraform-dir>
set -euo pipefail

dir="${1:?Usage: require-latest-state.sh <terraform-dir>}"
state="${dir}/terraform.tfstate"
[ -f "$state" ] || exit 0
cd "$dir"
git ls-files --error-unmatch terraform.tfstate >/dev/null 2>&1 || exit 0

path="$(git rev-parse --show-prefix)terraform.tfstate"
lineage="$(jq -r .lineage terraform.tfstate)"
serial="$(jq -r .serial terraform.tfstate)"
git fetch -q --prune origin || { echo "ERROR: could not fetch origin to compare ${path} against." >&2; exit 1; }

newer=()
while read -r ref; do
    theirs="$(git show "${ref}:${path}" 2>/dev/null)" || continue
    [ "$(jq -r .lineage <<<"$theirs")" = "$lineage" ] || continue
    their_serial="$(jq -r .serial <<<"$theirs")"
    [ "$their_serial" -gt "$serial" ] && newer+=("${ref#refs/remotes/} (serial ${their_serial})")
done < <(git for-each-ref --format='%(refname)' refs/remotes/origin | grep -v '/HEAD$')

[ "${#newer[@]}" -eq 0 ] && exit 0
echo "ERROR: ${path} here is serial ${serial}; a newer one waits on:" >&2
printf '  %s\n' "${newer[@]}" >&2
echo "  Merge that PR, then: git pull" >&2
exit 1
