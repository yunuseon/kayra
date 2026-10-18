#!/usr/bin/env bash
# Runs play.yml against localhost through kayra's Ansible output
# (ansible/callback_plugins/kayra.py) and compares what it prints with
# expected.txt: changed tasks with their diff, a debug message, a secret kept
# out, an ignored failure, a retry, a failure with its output, the recap. ok and
# skipped tasks must not appear.
#   bash ci/tests/ansible-output/run.sh [--record]
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT

status=0
out="$(cd "$here" && ANSIBLE_CONFIG="${here}/../../../ansible/ansible.cfg" ANSIBLE_NOCOLOR=1 \
    ansible-playbook -i localhost, -c local -e "dir=${dir}" play.yml 2>/dev/null)" || status=$?
# Times depend on the machine, the temp dir on the run.
actual="$(printf '%s\n--- exit %s\n' "$out" "$status" | sed -E -e "s|${dir}|<dir>|g" -e 's/ +(· )?([0-9]+[hm])?[0-9.]+[sm]$//')"

if [ "${1:-}" = --record ]; then
    printf '%s\n' "$actual" > "${here}/expected.txt"
elif ! diff -u "${here}/expected.txt" <(printf '%s\n' "$actual"); then
    echo "kayra's Ansible output changed: compare, then --record if that was meant" >&2
    exit 1
fi
