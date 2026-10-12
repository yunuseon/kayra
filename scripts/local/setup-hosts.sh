#!/usr/bin/env bash
# Point <domain> and its subdomains at <ip> in /etc/hosts. Requires sudo.
# Subdomains: the platform's (hosts.conf) plus the given ones —
# callers pass their apps' subdomains, as they do to certs.sh.
#
# Usage: bash scripts/local/setup-hosts.sh <domain> <ip> [subdomain…]
set -euo pipefail

KAYRA_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOMAIN="${1:?Usage: setup-hosts.sh <domain> <ip>}"
IP="${2:?Usage: setup-hosts.sh <domain> <ip> [subdomain…]}"
shift 2

echo "==> Updating /etc/hosts for ${DOMAIN} -> ${IP}..."

if grep -q "${DOMAIN}" /etc/hosts 2>/dev/null; then
  echo "    Removing old entries..."
  sudo sed -i.bak "/${DOMAIN}/d" /etc/hosts
fi

HOSTS=""
for sub in $(awk '!/^[[:space:]]*(#|$)/ {print $1}' "${KAYRA_ROOT}"/hosts.conf) "$@"; do
  HOSTS="${HOSTS} ${sub}.${DOMAIN}"
done

echo "${IP} ${DOMAIN}${HOSTS}" | sudo tee -a /etc/hosts > /dev/null

echo ""
echo "Done — /etc/hosts updated:"
grep "${DOMAIN}" /etc/hosts
