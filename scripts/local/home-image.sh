#!/usr/bin/env bash
# Builds what a target: home server boots from, since nothing can create it
# for us: the Ubuntu cloud image, grown to vm.disk, and a seed ISO with the
# same cloud-init as every other server plus its fixed address. Both go into
# the hypervisor by hand, once: the image as the VM's disk, the ISO as a CD.
#
# Usage: FLEET_ROOT=<fleet> bash scripts/local/home-image.sh <server-name>
# Writes servers/<name>/vm/ (gitignored): <name>.qcow2, seed.iso.
set -euo pipefail

FLEET_ROOT="${FLEET_ROOT:?the directory of the fleet (servers/), set by kayra}"
KAYRA_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
name="${1:?Usage: home-image.sh <server-name>}"
dir="${FLEET_ROOT}/servers/${name}"
out="${dir}/vm"

# Pinned. Only the first boot uses it; Ansible keeps the server current after.
image_url=https://cloud-images.ubuntu.com/releases/noble/release-20260926/ubuntu-24.04-server-cloudimg-amd64.img
image_sha256=6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2

command -v qemu-img >/dev/null || { echo "ERROR: qemu-img not installed. Run: brew install qemu" >&2; exit 1; }

address="$(yq '.vm.address' "${dir}/vars.yml")"
gateway="$(yq '.vm.gateway' "${dir}/vars.yml")"
disk="$(yq '.vm.disk' "${dir}/vars.yml")"
key="$(sed -n 's/.*ansible_ssh_private_key_file=\([^ ]*\).*/\1/p' "${dir}/inventory.ini" | head -1).pub"

mkdir -p "${out}/seed"
image="${out}/cloudimg-${image_sha256:0:12}.img"
if [ ! -f "$image" ]; then
    curl -fL --progress-bar -o "${image}.part" "$image_url"
    mv "${image}.part" "$image"
fi
echo "${image_sha256}  ${image}" | shasum -a 256 -c --quiet

rm -f "${out}/${name}.qcow2"
qemu-img convert -O qcow2 "$image" "${out}/${name}.qcow2"
qemu-img resize -q "${out}/${name}.qcow2" "$disk"

sed -e "s|[$]{hostname}|${name}|" -e "s|[$]{ssh_pubkey}|$(cat "$key")|" \
    "${KAYRA_ROOT}/cloud-init.yml.tpl" > "${out}/seed/user-data"
printf 'instance-id: %s\nlocal-hostname: %s\n' "$name" "$name" > "${out}/seed/meta-data"
cat > "${out}/seed/network-config" <<NETWORK
version: 2
ethernets:
  lan:
    match: {name: "e*"}
    addresses: [${address}]
    routes: [{to: default, via: ${gateway}}]
    nameservers: {addresses: [${gateway}]}
NETWORK

rm -f "${out}/seed.iso"
hdiutil makehybrid -quiet -iso -joliet -default-volume-name cidata -o "${out}/seed.iso" "${out}/seed"
echo "Built ${out}/${name}.qcow2 (${disk}) and ${out}/seed.iso: import the first as the VM's disk, attach the second as a CD."
