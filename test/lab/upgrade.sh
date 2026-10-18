#!/usr/bin/env bash
# =============================================================================
# test/lab/upgrade.sh [--from <version>] [--keep] — the upgrade lab.
#
# What broke on real servers broke on upgrades, not fresh installs. This
# brings a throwaway platform server up as a Multipass VM at the last
# release (or --from), with a fixture app (test/lab/app), then upgrades it to
# this checkout and runs every deploy path against it:
#
#   1  the release: kayra deploy, the app's first deploy by a signed webhook
#   2  the upgrade: the fleet's kayra becomes this checkout, kayra deploy
#      (which ends with kayra verify)
#   3  a new commit by webhook; deploying it again builds nothing (CACHED)
#   4  a commit the compose policy refuses: the run fails, the old one serves
#   5  kayra app rollback to the first release; the registry GC; kayra verify
#
# The fleet lives in a temp directory, never in a real one; the app's
# repository is served to the VM over HTTP from this Mac. Runs on the
# operator's Mac (Multipass, mkcert, OpenTofu, Ansible, Node, python3), about
# 15 minutes. After a full pass the VM is destroyed (unless --keep); after a
# failure it is kept, with the fleet and the log, for a look.
# =============================================================================
set -euo pipefail

KAYRA_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
from=""
keep=false
while [ $# -gt 0 ]; do
    case "$1" in
        --from) from="$2"; shift 2 ;;
        --keep) keep=true; shift ;;
        *) echo "Usage: $0 [--from <version>] [--keep]" >&2; exit 2 ;;
    esac
done
[ -n "$from" ] || from="$(git -C "$KAYRA_ROOT" describe --tags --abbrev=0 --match 'v*' | sed 's/^v//')"

server=lab
domain=lab.test
secret=lab-webhook-secret
work="$(mktemp -d)"
fleet="${work}/fleet"
repo="${work}/repo"
served="${work}/served"
log="${work}/lab.log"
step() { printf '\n── %s\n' "$*"; }
die() { echo "✗ $*" >&2; echo "  the lab: ${work} (log: ${log})" >&2; exit 1; }

# ── The Mac's address on Multipass's bridge, where the VM fetches the app ──
host_ip="$(ifconfig bridge100 2>/dev/null | awk '/inet / {print $2; exit}')"
[ -n "$host_ip" ] || die "no Multipass bridge (bridge100): is Multipass running?"
port=18765

passed=false
cleanup() {
    [ -z "${server_pid:-}" ] || kill "$server_pid" 2>/dev/null || true
    if [ "$passed" = false ]; then
        echo "kept for a look: the VM (kayra-lab), the fleet ${fleet}, the log ${log}"
        echo "  then: (cd ${fleet} && node node_modules/@yunuseon/kayra/bin/kayra.js down ${server}) && rm -rf ${work}"
    elif [ "$keep" = true ]; then
        echo "kept: the VM (kayra-lab) and ${work}; kayra down ${server} from ${fleet} removes the VM"
    elif [ -d "${fleet}/servers/${server}/terraform" ]; then
        (cd "$fleet" && kayra_cmd down "$server" >> "$log" 2>&1) || echo "kayra down ${server} failed; see ${log}" >&2
        rm -rf "$work"
    fi
}
trap cleanup EXIT

kayra_cmd() { node "${fleet}/node_modules/@yunuseon/kayra/bin/kayra.js" "$@"; }

# ── The app's repository, served over git's smart HTTP (kayra clones shallow) ─
step "the fixture app's repository"
mkdir -p "$served"
mkdir -p "$repo"
cp -R "${KAYRA_ROOT}/test/lab/app/." "$repo/"
git -C "$repo" init -q -b main
commit() { git -C "$repo" add -A && git -C "$repo" -c user.email=lab@kayra.test -c user.name=lab commit -qm "$1"; publish; }
publish() {
    rm -rf "${served}/lab/sample.git"
    git clone -q --bare "$repo" "${served}/lab/sample.git"
}
commit v1
python3 "${KAYRA_ROOT}/test/lab/git-http.py" "$host_ip" "$port" "$served" >> "$log" 2>&1 &
server_pid=$!
sleep 1
git clone -q --depth 1 "http://${host_ip}:${port}/lab/sample.git" "${work}/probe" && rm -rf "${work}/probe" || die "the app's repository is not served at http://${host_ip}:${port}/lab/sample.git"
echo "http://${host_ip}:${port}/lab/sample.git"

# ── A fleet pinned to the release ───────────────────────────────────────────
step "a fleet at kayra ${from}"
mkdir -p "${fleet}/servers/${server}/terraform" "${fleet}/servers/${server}/apps"
cat > "${fleet}/package.json" <<EOF
{"name": "kayra-lab", "private": true, "devDependencies": {"@yunuseon/kayra": "${from}"}}
EOF
(cd "$fleet" && npm install --silent --no-audit --no-fund >> "$log" 2>&1) || die "npm install @yunuseon/kayra@${from}"
cat > "${fleet}/servers/defaults.yml" <<'EOF'
---
acme_email: lab@kayra.test
EOF
descriptor() {
    printf -- '---\nkind: platform\ntarget: multipass\ndomain: %s\nvault: false\n' "$domain"
    [ "$1" = without-app ] || # owner/name, as on a forge: the builder knows a repo's forge, and its webhooks, by that shape.
    printf 'apps:\n  - {name: sample, repo: "http://%s:%s/lab/sample.git", ref: main, path: .}\n' "$host_ip" "$port"
}
descriptor with-app > "${fleet}/servers/${server}/server.yml"
cat > "${fleet}/servers/${server}/vars.yml" <<'EOF'
---
authelia_policy: one_factor
EOF
# Test values only; the hash is argon2id of 'lab'.
cat > "${fleet}/servers/${server}/secrets.yml" <<EOF
---
git_token: lab
webhook_secret: ${secret}
authelia_session_secret: lab-session-secret-at-least-64-characters-long-padding-padding-xx
authelia_storage_encryption_key: lab-storage-key-at-least-64-characters-long-padding-padding-xxx
authelia_users:
  lab:
    displayname: Lab
    email: lab@kayra.test
    password: "\$argon2id\$v=19\$m=32768,t=3,p=2\$I0A3lr5snxyrdOEFuWzpiw\$DUQdv4fWdPELxLPzYiW/mwHNe9reVUjFGYgc4RS3vcA"
    groups: [admin]
EOF
printf 'MODE: lab\n' > "${fleet}/servers/${server}/apps/sample.yml"
printf 'GREETING: hello\n' > "${fleet}/servers/${server}/apps/sample.secrets.yml"
cat > "${fleet}/servers/${server}/terraform/main.tf" <<'EOF'
terraform {
  required_providers {
    multipass = { source = "todoroff/multipass", version = "~> 1.7" }
    tls       = { source = "hashicorp/tls", version = "~> 4.0" }
    local     = { source = "hashicorp/local", version = "~> 2.5" }
  }
}

module "instance" {
  source         = "../../../node_modules/@yunuseon/kayra/terraform/modules/multipass-instance"
  name           = "kayra-lab"
  cpus           = 2
  memory         = "4G"
  disk           = "20G"
  ssh_key_dir    = abspath("${path.root}/../keys")
  inventory_path = abspath("${path.root}/../inventory.ini")
}

output "server_ip" { value = module.instance.ipv4_address }
EOF
cd "$fleet"
# Releases before http:// on multipass refuse the served repository: then the
# release sets up the platform only, and the app arrives with the upgrade.
app_at_release=true
if ! kayra_cmd validate "$server" >> "$log" 2>&1; then
    app_at_release=false
    descriptor without-app > "servers/${server}/server.yml"
    kayra_cmd validate "$server" >> "$log" 2>&1 || die "kayra ${from} refuses the lab fleet (${log})"
    echo "kayra ${from} cannot clone over http://: the app arrives with the upgrade"
fi

# ── Waiting on runs, and asking the app what it serves ──────────────────────
# The deployer's ctl as text, which every kayra the lab runs has: what `kayra app …` draws from it may change.
ctl() { kayra_cmd ssh "$server" -- cd /opt/platform '&&' docker compose exec -T deployer kayra-deployer ctl "$@"; }
newest_run() { ctl runs sample 2>/dev/null | head -1; }
# Waits for a run newer than $1 to end; prints its line (id state sha why what).
await_run() {
    local before="$1" line
    for _ in $(seq 1 90); do
        line="$(newest_run)"
        case "$line" in "$before"|"") ;; *" running "*) ;; *) echo "$line"; return 0 ;; esac
        sleep 10
    done
    die "no run ended within 15 minutes after: ${before}"
}
push_hook() {
    local body sig
    body='{"ref":"refs/heads/main"}'
    sig="$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$secret" | awk '{print $NF}')"
    curl -sf -o /dev/null --resolve "deploy.${domain}:443:${address}" -X POST \
        -H "X-Forgejo-Signature: ${sig}" -d "$body" "https://deploy.${domain}/hook/sample" || die "the signed webhook was refused"
}
serves() { curl -sf -m 10 --resolve "www.${domain}:443:${address}" "https://www.${domain}/" | tr -d '\n'; }
expect_serves() {
    local want="$1" got
    for _ in $(seq 1 12); do got="$(serves || true)"; [ "$got" = "$want" ] && { echo "✓ www.${domain} serves ${want}"; return 0; }; sleep 5; done
    die "www.${domain} serves '${got}', not ${want}"
}
state_of() { awk '{print $2}' <<< "$1"; }

# ── 1: the release ──────────────────────────────────────────────────────────
step "1  kayra ${from}: provision, deploy, the first webhook deploy"
kayra_cmd provision "$server" >> "$log" 2>&1 || die "kayra provision (${from})"
address="$(awk '{for (i = 1; i <= NF; i++) if (index($i, "ansible_host=") == 1) print substr($i, 14)}' "servers/${server}/inventory.ini")"
echo "VM at ${address}"
kayra_cmd deploy "$server" >> "$log" 2>&1 || die "kayra deploy (${from})"
first_deploy() {
    local before run
    before="$(newest_run)"
    push_hook
    run="$(await_run "$before")"
    [ "$(state_of "$run")" = success ] || die "the first deploy: ${run}"
    expect_serves v1
}
[ "$app_at_release" = false ] || first_deploy

# ── 2: the upgrade ──────────────────────────────────────────────────────────
step "2  the upgrade to this checkout ($(git -C "$KAYRA_ROOT" rev-parse --short HEAD))"
rm -rf node_modules/@yunuseon/kayra
ln -s "$KAYRA_ROOT" node_modules/@yunuseon/kayra
[ "$app_at_release" = true ] || descriptor with-app > "servers/${server}/server.yml"
upgraded="$(kayra_cmd deploy "$server" 2>&1)" && ok=true || ok=false
printf '%s\n' "$upgraded" >> "$log"
grep -E '^(    )?(✓|✗)' <<< "$upgraded" || true
[ "$ok" = true ] || die "kayra deploy after the upgrade"
[ "$app_at_release" = true ] || first_deploy
expect_serves v1

# ── 3: a new commit; deploying it again builds nothing ─────────────────────
step "3  a new commit by webhook, then the same commit again"
echo v2 > "${repo}/web/index.html"
commit v2
before="$(newest_run)"
push_hook
run="$(await_run "$before")"
[ "$(state_of "$run")" = success ] || die "the v2 deploy: ${run}"
expect_serves v2
kayra_cmd app runs "$server" sample | grep -q "^  STATE  *COMMIT" || die "kayra app runs prints the deployer's answer undrawn"
echo "✓ kayra app runs draws the runs"
before="$run"
kayra_cmd app deploy "$server" sample >> "$log" 2>&1
run="$(await_run "$before")"
[ "$(state_of "$run")" = success ] || die "deploying v2 again: ${run}"
kayra_cmd app logs "$server" sample | grep -q "CACHED localhost:5000/sample/web" || die "deploying the same commit again rebuilt the image"
echo "✓ the same commit again: CACHED"

# ── 4: a commit the policy refuses ──────────────────────────────────────────
step "4  a commit the compose policy refuses"
yq -i '.services.web.volumes = ["/etc:/host-etc"]' "${repo}/deploy/compose.yml"
commit "bind mount"
before="$run"
push_hook
run="$(await_run "$before")"
[ "$(state_of "$run")" = failure ] || die "the refused commit deployed: ${run}"
kayra_cmd app logs "$server" sample | grep -q "bind mount /etc -> /host-etc" || die "the refusal does not name the bind mount"
echo "✓ refused: bind mount /etc -> /host-etc"
expect_serves v2

# ── 5: rollback, GC, verify ─────────────────────────────────────────────────
step "5  rollback to the first release, the registry GC, kayra verify"
first="$(ctl rollback sample | awk 'NR > 1 {print $1}' | tail -1)"
[ -n "$first" ] || die "the deployer lists no earlier release"
kayra_cmd app rollback "$server" sample | grep -q " live$" || die "kayra app rollback prints the releases undrawn"
echo "✓ kayra app rollback draws the releases"
before="$run"
kayra_cmd app rollback "$server" sample "${first:0:12}" >> "$log" 2>&1
run="$(await_run "$before")"
[ "$(state_of "$run")" = success ] || die "the rollback: ${run}"
expect_serves v1
kayra_cmd job "$server" gc >> "$log" 2>&1
for _ in $(seq 1 12); do
    kayra_cmd app logs "$server" gc 2>/dev/null | grep -q "Total reclaimed space" && break
    sleep 5
done
kayra_cmd app logs "$server" gc | grep -q "Total reclaimed space" || die "the registry GC did not run through"
echo "✓ the registry GC ran"
kayra_cmd verify "$server" || die "kayra verify after the scenario"

passed=true
step "the upgrade from ${from} holds"
