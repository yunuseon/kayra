#!/usr/bin/env bash
# Generate local-trusted TLS certs (mkcert) for Traefik.
# Covers `<domain>`, `*.<domain>`, the platform's subdomains and the given ones.
#
# Usage: bash scripts/local/certs.sh <domain> <certs-dir> [subdomain…]
# Output: <certs-dir>/cert.pem, <certs-dir>/key.pem
#
# A no-op when the existing cert already covers <domain>. Local dev and the
# multipass VM share one certs dir with different domains, so "the file exists"
# is not enough: shipping the local cert to the VM would break every hostname.
set -euo pipefail

KAYRA_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOMAIN="${1:?Usage: certs.sh <domain> <certs-dir> [subdomain…]}"
CERTS_DIR="${2:?}"
shift 2

if [ -f "${CERTS_DIR}/key.pem" ] && [ -f "${CERTS_DIR}/cert.pem" ] \
   && openssl x509 -in "${CERTS_DIR}/cert.pem" -noout -ext subjectAltName | grep -qE "DNS:${DOMAIN}(,|$)"; then
  exit 0
fi

if ! command -v mkcert >/dev/null 2>&1; then
  echo "ERROR: mkcert not installed. Run: brew install mkcert nss && mkcert -install" >&2
  exit 1
fi

# First run on this machine? Install the local CA into the system trust store.
if [ ! -f "$(mkcert -CAROOT)/rootCA.pem" ]; then
  echo "==> Installing mkcert local CA (one-time, may prompt for sudo)..."
  mkcert -install
fi

mkdir -p "${CERTS_DIR}"

# Explicit subdomain SANs alongside the wildcard: Apple's SecureTransport (used
# by macOS-bundled curl) doesn't match `*.domain` wildcards. Chrome is fine, but
# pipelines and smoke tests that use system curl break without these.
NAMES=("${DOMAIN}" "*.${DOMAIN}")
for sub in $(awk '!/^[[:space:]]*(#|$)/ {print $1}' "${KAYRA_ROOT}"/hosts.conf) "$@"; do
  NAMES+=("${sub}.${DOMAIN}")
done
# Keep plain localhost working for native (non-compose) dev.
NAMES+=(localhost "*.localhost" 127.0.0.1 ::1)

echo "==> Generating cert for ${DOMAIN} (${#NAMES[@]} names)..."
mkcert \
  -cert-file "${CERTS_DIR}/cert.pem" \
  -key-file  "${CERTS_DIR}/key.pem" \
  "${NAMES[@]}"

chmod 644 "${CERTS_DIR}/cert.pem"
chmod 600 "${CERTS_DIR}/key.pem"

echo "Done — ${CERTS_DIR}/cert.pem + key.pem"
