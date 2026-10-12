#!/usr/bin/env bash
# Can Ansible get into a home machine (target: home)? If not, say why, in the
# terms of the failures seen there, before Ansible's UNREACHABLE does not.
#
# Usage: FLEET_ROOT=<fleet> bash scripts/local/home-reach.sh <server-name> <kind>
set -euo pipefail

FLEET_ROOT="${FLEET_ROOT:?the directory of the fleet (servers/), set by kayra}"
name="${1:?Usage: home-reach.sh <server-name> <kind>}"
kind="${2:?Usage: home-reach.sh <server-name> <kind>}"
inv="${FLEET_ROOT}/servers/${name}/inventory.ini"
field() { sed -n "s/.*${1}=\([^ ]*\).*/\1/p" "$inv" | head -1; }
host="$(field ansible_host)"
user="$(field ansible_user)"
key="$(field ansible_ssh_private_key_file)"
port="$(field ansible_port)"

if out="$(ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
    -p "${port:-22}" -i "${key/#\~/$HOME}" "${user}@${host}" true 2>&1)"; then
  exit 0
fi

echo "ERROR: cannot SSH into ${name} (${user}@${host}):" >&2
echo "$out" | grep -v '^\*\*' | sed 's/^/  /' >&2
case "$out" in
  *"Connection refused"*)
    if [ "$kind" = nas ]; then
      echo "  SSH is off: it is on only on demand, for a set time. UGOS: Control Panel → Terminal → SSH on." >&2
    else
      echo "  Nothing listens on port ${port:-22}: is the machine up and sshd running?" >&2
    fi ;;
  *"Permission denied"*)
    echo "  The key is refused. Is it in the agent? ssh-add ${key}" >&2
    if [ "$kind" = nas ]; then
      echo "  If it is: UGOS resets permissions, and sshd ignores a writable ~/.ssh. On the NAS:" >&2
      echo "    chmod 755 ~ && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys" >&2
    fi ;;
  *"timed out"*|*"No route to host"*|*"not known"*)
    echo "  ${host} does not answer: is the machine on, and is this Mac on the home network?" >&2 ;;
esac
exit 1
