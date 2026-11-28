#!/usr/bin/env bash
# =============================================================================
# test/lab/upgrade.sh [--from <version>] [--vm-name <name>] [--indexed-registration] [--swarm-host] [--managed-rollouts | --managed-fleet | --managed-forward | --managed-workers] [--egress-mtu <1280-1500>] [--keep] — the upgrade lab.
#
# What broke on real servers broke on upgrades, not fresh installs. This
# brings a throwaway platform server up as a Multipass VM at the last
# release (or --from), with a fixture app (test/lab/app), then upgrades it to
# this checkout and runs every deploy path against it:
#
#   1  the release: kayra deploy, the app's first deploy by a signed webhook,
#      the app as the release knew it (test/lab/app at its tag)
#   2  the upgrade: the fleet's kayra becomes this checkout, kayra plan (check
#      mode on the release's server), kayra deploy (which ends with kayra
#      verify), kayra status reading back the kayra that set it up; the old
#      containers keep serving
#   3  the app as this checkout knows it, in a commit of its own (what an app
#      does when kayra's contract changes), then a new commit by webhook;
#      deploying it again builds nothing (CACHED)
#   4  a commit the compose policy refuses: the run fails, the old one serves
#   5  kayra app rollback to the first release after the upgrade; the
#      registry GC; kayra verify
#   6  webhooks: false with a short deploy_poll: verify sees no /hook, and a
#      push nobody announces deploys by the poll alone
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
indexed_registration=false
swarm_host=false
managed_rollouts=false
managed_fleet=false
managed_forward=false
managed_workers=false
egress_mtu=""
vm_name="kayra-lab"
while [ $# -gt 0 ]; do
    case "$1" in
        --from) [ $# -ge 2 ] || { echo "--from requires a version" >&2; exit 2; }; from="$2"; shift 2 ;;
        --vm-name) [ $# -ge 2 ] || { echo "--vm-name requires a name" >&2; exit 2; }; vm_name="$2"; shift 2 ;;
        --indexed-registration) indexed_registration=true; shift ;;
        --swarm-host) swarm_host=true; shift ;;
        --managed-rollouts) managed_rollouts=true; indexed_registration=true; swarm_host=true; shift ;;
        --managed-fleet) managed_fleet=true; shift ;;
        --managed-forward) managed_forward=true; shift ;;
        --managed-workers) managed_workers=true; shift ;;
        --egress-mtu) [ $# -ge 2 ] || { echo "--egress-mtu requires a value" >&2; exit 2; }; egress_mtu="$2"; shift 2 ;;
        --keep) keep=true; shift ;;
        *) echo "Usage: $0 [--from <version>] [--vm-name <name>] [--indexed-registration] [--swarm-host] [--managed-rollouts | --managed-fleet | --managed-forward | --managed-workers] [--egress-mtu <1280-1500>] [--keep]" >&2; exit 2 ;;
    esac
done
if { [ "$managed_fleet" = true ] || [ "$managed_forward" = true ] || [ "$managed_workers" = true ]; } && { [ "$indexed_registration" = true ] || [ "$swarm_host" = true ]; }; then
    echo "Managed fleet, forward and worker labs use the production provisioning path in their own VM" >&2
    exit 2
fi
if [ -n "$egress_mtu" ] && { ! [[ "$egress_mtu" =~ ^[0-9]{4}$ ]] || [ "$egress_mtu" -lt 1280 ] || [ "$egress_mtu" -gt 1500 ]; }; then
    echo "invalid lab egress MTU: $egress_mtu" >&2
    exit 2
fi
[[ "$vm_name" =~ ^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$ ]] || { echo "invalid Multipass VM name: ${vm_name}" >&2; exit 2; }
if multipass info "$vm_name" >/dev/null 2>&1; then
    echo "Multipass VM ${vm_name} already exists; choose a different --vm-name" >&2
    exit 1
fi
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

passed=false
oom_timing_invalid=false
retain_lab_log() {
    [ -f "$log" ] || return 0
    local archive
    archive="$(mktemp -d "/tmp/kayra-upgrade-${vm_name}.XXXXXX")"
    cp "$log" "${archive}/lab.log"
    chmod 0600 "${archive}/lab.log"
    echo "raw lab log: ${archive}/lab.log"
}
cleanup() {
    [ -z "${server_pid:-}" ] || kill "$server_pid" 2>/dev/null || true
    [ -z "${maintenance_pid:-}" ] || kill "$maintenance_pid" 2>/dev/null || true
    if [ "$passed" = false ]; then
        retain_lab_log
        echo "kept for a look: the VM (${vm_name}), the fleet ${fleet}, the log ${log}"
        echo "  then: (cd ${fleet} && node node_modules/@yunuseon/kayra/bin/kayra.js down ${server}) && rm -rf ${work}"
    elif [ "$keep" = true ]; then
        retain_lab_log
        echo "kept: the VM (${vm_name}) and ${work}; kayra down ${server} from ${fleet} removes the VM"
    elif [ -d "${fleet}/servers/${server}/terraform" ]; then
        if (cd "$fleet" && kayra_cmd down "$server" >> "$log" 2>&1); then
            retain_lab_log
            rm -rf "$work"
        else
            retain_lab_log
            echo "kayra down ${server} failed; kept the VM (${vm_name}), fleet ${fleet}, and log ${log}" >&2
            echo "  retry: (cd ${fleet} && node node_modules/@yunuseon/kayra/bin/kayra.js down ${server}) && rm -rf ${work}" >&2
            trap - EXIT
            exit 1
        fi
    fi
}
trap cleanup EXIT

kayra_cmd() { node "${fleet}/node_modules/@yunuseon/kayra/bin/kayra.js" "$@"; }

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
# Before 0.21 a fleet's secrets were Ansible Vault (vault: in server.yml, an
# app's in apps/<app>.secrets.yml); since, secrets.yml is SOPS, opened with an
# age key, an app's under app_secrets.
sops_fleet=false
[ "$(printf '%s\n0.21.0\n' "$from" | sort -V | head -1)" = 0.21.0 ] && sops_fleet=true
descriptor() {
    printf -- '---\nkind: platform\ntarget: multipass\ndomain: %s\n' "$domain"
    if [ "$sops_fleet" = true ]; then printf 'age_key_file: %s\n' "${work}/age-key.txt"; else printf 'vault: false\n'; fi
    [ "$1" = without-app ] || # owner/name, as on a forge: the builder knows a repo's forge, and its webhooks, by that shape.
    printf 'apps:\n  - {name: sample, repo: "http://%s:%s/lab/sample.git", ref: main, path: .}\n' "$host_ip" "$port"
}
descriptor without-app > "${fleet}/servers/${server}/server.yml"
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
# What an operator does once on the way to 0.21 (Upgrading to 0.21): an age
# key, .sops.yaml naming it, the app's secrets into secrets.yml, encrypted.
to_sops() {
    age-keygen -o "${work}/age-key.txt" 2> /dev/null
    printf 'creation_rules:\n  - path_regex: ^servers/[^/]+/secrets\\.yml$\n    age: %s\n' "$(age-keygen -y "${work}/age-key.txt")" > "${fleet}/.sops.yaml"
    yq -i ".app_secrets.sample = load(\"${fleet}/servers/${server}/apps/sample.secrets.yml\")" "${fleet}/servers/${server}/secrets.yml"
    rm "${fleet}/servers/${server}/apps/sample.secrets.yml"
    (cd "$fleet" && sops encrypt --in-place "servers/${server}/secrets.yml")
}
[ "$sops_fleet" = false ] || to_sops
# Releases before 0.26 let the fleet select the Multipass provider's major.
# Keep the old provider for the first deployment, then switch the disposable
# fleet to the checkout's module constraints before planning the upgrade.
legacy_providers="${fleet}/servers/${server}/terraform/legacy-providers.tf"
if [ "$(printf '%s\n0.26.0\n' "$from" | sort -V | head -1)" != 0.26.0 ]; then
    cat > "$legacy_providers" <<'EOF'
terraform {
  required_providers {
    multipass = { source = "todoroff/multipass", version = "~> 1.7" }
    tls       = { source = "hashicorp/tls", version = "~> 4.0" }
    local     = { source = "hashicorp/local", version = "~> 2.5" }
  }
}
EOF
fi
sed "s/__KAYRA_LAB_VM_NAME__/${vm_name}/" > "${fleet}/servers/${server}/terraform/main.tf" <<'EOF'
module "instance" {
  source         = "../../../node_modules/@yunuseon/kayra/terraform/modules/multipass-instance"
  name           = "__KAYRA_LAB_VM_NAME__"
  cpus           = 2
  memory         = "4G"
  disk           = "20G"
  ssh_key_dir    = abspath("${path.root}/../keys")
  inventory_path = abspath("${path.root}/../inventory.ini")
}

output "server_ip" { value = module.instance.ipv4_address }
EOF
cd "$fleet"
# ── Waiting on runs, and asking the app what it serves ──────────────────────
# The deployer's ctl as text, which every kayra the lab runs has: what `kayra app …` draws from it may change.
ctl() { kayra_cmd ssh "$server" -- cd /opt/platform '&&' docker compose exec -T deployer kayra-deployer ctl "$@"; }
new_uuid() { python3 -c 'import uuid; print(uuid.uuid4())'; }
await_managed_phase() {
    local app="$1" run="$2" phase="$3" report="$4"
    for _ in $(seq 1 110); do
        if ctl lifecycle status "$app" > "$report" 2>> "$log"; then
            if jq -e --arg run "$run" --arg phase "$phase" '.operation.run == $run and .operation.phase == $phase' "$report" >/dev/null; then
                install -m 600 "$report" "/tmp/kayra-swarm-platform-${vm_name}.$(basename "$report")"
                return 0
            fi
            if jq -e --arg run "$run" '.operation.run == $run and (.operation.phase == "held" or .operation.phase == "complete")' "$report" >/dev/null; then
                install -m 600 "$report" "/tmp/kayra-swarm-platform-${vm_name}.$(basename "$report")"
                die "$app reached an unexpected terminal phase"
            fi
        fi
        sleep 2
    done
    die "$app did not reach ${phase}"
}
newest_run() { ctl runs sample 2>/dev/null | head -1; }
# Waits for a run newer than $1 to end; prints its line (id state sha why what).
await_run() {
    local before="$1" line
    for _ in $(seq 1 90); do
        line="$(newest_run)"
        case "$line" in "$before"|"") ;; *" running "*|*" queued "*) ;; *) echo "$line"; return 0 ;; esac
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
if [ -n "$egress_mtu" ]; then
    multipass exec "$vm_name" -- sh -ec '
        device=$(ip -4 route show default | awk "NR == 1 {print \$5}")
        test -n "$device"
        sudo ip link set dev "$device" mtu "$1"
        ip link show dev "$device"
    ' sh "$egress_mtu" >> "$log" 2>&1 || die "setting the disposable VM egress MTU"
fi
# Multipass creates its private network on demand. Ask the provisioned VM
# for the gateway and bind the Git fixture only to that host interface.
host_ip="$(multipass exec "$vm_name" -- ip -4 route show default | awk 'NR == 1 && $1 == "default" && $2 == "via" { print $3 }')" ||
    die "reading the disposable VM gateway"
[ -n "$host_ip" ] || die "the disposable VM has no IPv4 gateway"
# ── The app's repository, served over git's smart HTTP (kayra clones shallow) ─
step "the fixture app's repository"
mkdir -p "$served"
mkdir -p "$repo"
# The app as the release knew it: a contract change between it and this
# checkout is the app's to make, in a commit of its own (step 3).
if git -C "$KAYRA_ROOT" cat-file -e "v${from}:test/lab/app" 2>/dev/null; then
    git -C "$KAYRA_ROOT" archive "v${from}" test/lab/app | tar -x -C "$work"
    cp -R "${work}/test/lab/app/." "$repo/"
else
    cp -R "${KAYRA_ROOT}/test/lab/app/." "$repo/"
fi
# The app as this checkout knows it.
adopt_checkout_app() {
    find "$repo" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
    cp -R "${KAYRA_ROOT}/test/lab/app/." "$repo/"
}
git -C "$repo" init -q -b main
commit() { git -C "$repo" add -A && git -C "$repo" -c user.email=lab@kayra.test -c user.name=lab commit -qm "$1"; publish; }
publish() {
    rm -rf "${served}/lab/sample.git"
    git clone -q --bare "$repo" "${served}/lab/sample.git"
}
commit v1
port_file="${work}/git-port"
python3 "${KAYRA_ROOT}/test/lab/git-http.py" "$host_ip" 0 "$served" "$port_file" >> "$log" 2>&1 &
server_pid=$!
for _ in $(seq 1 50); do
    [ ! -s "$port_file" ] || break
    kill -0 "$server_pid" 2>/dev/null || die "the fixture HTTP server did not start"
    sleep 0.1
done
[ -s "$port_file" ] && kill -0 "$server_pid" 2>/dev/null || die "the fixture HTTP server did not start"
port="$(cat "$port_file")"
git clone -q --depth 1 "http://${host_ip}:${port}/lab/sample.git" "${work}/probe" || die "the app's repository is not served at http://${host_ip}:${port}/lab/sample.git"
[ "$(git -C "${work}/probe" rev-parse HEAD)" = "$(git -C "$repo" rev-parse HEAD)" ] && kill -0 "$server_pid" 2>/dev/null || die "the fixture HTTP server did not return this lab's repository"
rm -rf "${work}/probe"
echo "http://${host_ip}:${port}/lab/sample.git"

descriptor with-app > "servers/${server}/server.yml"
# Releases before http:// on multipass refuse the served repository: then the
# release sets up the platform only, and the app arrives with the upgrade.
app_at_release=true
if ! kayra_cmd validate "$server" >> "$log" 2>&1; then
    app_at_release=false
    descriptor without-app > "servers/${server}/server.yml"
    kayra_cmd validate "$server" >> "$log" 2>&1 || die "kayra ${from} refuses the lab fleet (${log})"
    echo "kayra ${from} cannot clone over http://: the app arrives with the upgrade"
fi

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
if [ -f "$legacy_providers" ]; then
    rm "$legacy_providers"
    tofu -chdir="servers/${server}/terraform" init -upgrade -input=false >> "$log" 2>&1 ||
        die "upgrading the disposable fleet's OpenTofu providers"
fi
upgrade() {
    local upgraded ok
    upgraded="$(kayra_cmd "$1" "$server" 2>&1)" && ok=true || ok=false
    printf '%s\n' "$upgraded" >> "$log"
    grep -E '^(    )?(✓|✗|!)' <<< "$upgraded" || true
    [ "$ok" = true ] || die "kayra $1 after the upgrade"
}
if [ "$sops_fleet" = false ]; then
    sops_fleet=true
    to_sops
    descriptor "$([ "$app_at_release" = true ] && echo with-app || echo without-app)" > "servers/${server}/server.yml"
    echo "✓ the fleet's secrets moved to SOPS, as Upgrading to 0.21 says"
fi
[ "$app_at_release" = true ] || descriptor with-app > "servers/${server}/server.yml"
kayra_cmd plan "$server" >> "$log" 2>&1 || die "kayra plan after the upgrade, before its deploy (check mode)"
echo "✓ kayra plan: the upgraded playbook in check mode"
# Where the app contract changed since the release, the cutover an operator
# follows: the platform first (setup keeps the registrations the release
# wrote, and the old containers keep serving), then the app's own commit,
# then kayra deploy registers it from its new app.yml.
cutover=false
if [ "$app_at_release" = false ]; then
    adopt_checkout_app
    commit "v1: the app as this checkout knows it"
    upgrade deploy
    first_deploy
elif diff -rq -x .git "$repo" "${KAYRA_ROOT}/test/lab/app" > /dev/null; then
    upgrade deploy
else
    cutover=true
    echo "the app contract changed since ${from}: kayra setup first, kayra deploy after the app's own commit"
    upgrade setup
fi
running="$(kayra_cmd status --json | jq -r --arg name "$server" '.servers[] | select(.name == $name) | .kayra | select(.state == "recorded" and .version == .pin) | .version')"
[ -n "$running" ] || die "kayra status does not read back the kayra that set ${server} up: $(kayra_cmd status --json | jq -c '.servers[].kayra')"
echo "✓ kayra status: set up by kayra ${running}, the pin"
expect_serves v1

step "2a  the deployer refuses work while the host owns the app lock"
before="$(newest_run)"
multipass exec "$vm_name" -- sudo flock /opt/platform/removal-locks/sample.lock sh -c 'touch /tmp/kayra-app-lock-held; sleep 15' >> "$log" 2>&1 &
holder=$!
for _ in $(seq 1 25); do
    multipass exec "$vm_name" -- test -e /tmp/kayra-app-lock-held && break
    sleep 0.2
done
multipass exec "$vm_name" -- test -e /tmp/kayra-app-lock-held || die "the host did not acquire the fixture app lock"
if refused="$(ctl deploy sample 2>&1)"; then
    die "the deployer accepted work during a host app operation"
fi
grep -q 'app lifecycle is busy' <<< "$refused" || die "unexpected deploy refusal while the app lock is held"
[ "$(newest_run)" = "$before" ] || die "a refused deploy wrote a run record"
wait "$holder"
echo "✓ host app lock refused deployment before queuing a run"

# ── 3: the app as this checkout knows it; a new commit; the same again ─────
step "3  the app as this checkout knows it, a new commit by webhook, then the same commit again"
adopt_checkout_app
echo v2 > "${repo}/web/index.html"
commit "v2: the app as this checkout knows it"
before="$(newest_run)"
push_hook
run="$(await_run "$before")"
[ "$(state_of "$run")" = success ] || die "the v2 deploy: ${run}"
expect_serves v2
v2="$(awk '{print $3}' <<< "$run")"
if [ "$cutover" = true ]; then
    upgrade deploy
    expect_serves v2
fi
echo v3 > "${repo}/web/index.html"
commit v3
before="$run"
push_hook
run="$(await_run "$before")"
[ "$(state_of "$run")" = success ] || die "the v3 deploy: ${run}"
expect_serves v3
kayra_cmd app runs "$server" sample | grep -q "^  STATE  *COMMIT" || die "kayra app runs prints the deployer's answer undrawn"
echo "✓ kayra app runs draws the runs"
before="$run"
deployed="$(kayra_cmd app deploy "$server" sample 2>&1)" || { printf '%s\n' "$deployed" >> "$log"; die "kayra app deploy did not end in success"; }
printf '%s\n' "$deployed" >> "$log"
grep -q "✓ sample [0-9a-f]\{7\} deployed (run " <<< "$deployed" || die "kayra app deploy does not end with what it deployed"
grep -q "https://www.${domain}/" <<< "$deployed" || die "kayra app deploy does not say where the app answers"
echo "✓ kayra app deploy follows its run to the end: what it deployed, and where"
run="$(await_run "$before")"
[ "$(state_of "$run")" = success ] || die "deploying v3 again: ${run}"
kayra_cmd app logs "$server" sample | grep -q "CACHED localhost:5000/sample/web" || die "deploying the same commit again rebuilt the image"
echo "✓ the same commit again: CACHED"
kayra_cmd app logs "$server" sample | grep -q "ready  https://www.${domain}/  " || die "the deploy did not ask its route through Traefik"
echo "✓ readiness: www.${domain} answered through Traefik"

# The legacy restart path observes Compose projects before deciding whether a
# previously deployed app needs to be started again. This exercises the actual
# deployer after an intentional stop inside this disposable VM.
step "3a  restore a stopped legacy Compose app after deployer restart"
before="$run"
multipass exec "$vm_name" -- sudo docker stop sample-web-1 >> "$log" 2>&1 || die "could not stop the fixture app"
multipass exec "$vm_name" -- sudo docker restart platform-deployer-1 >> "$log" 2>&1 || die "could not restart the lab deployer"
run="$(await_run "$before")"
[ "$(state_of "$run")" = success ] || die "the legacy restore failed: ${run}"
case "$run" in *" restore "*) ;; *) die "the app restarted for a reason other than restore: ${run}" ;; esac
expect_serves v3
echo "✓ stopped Compose app restored after deployer restart"

step "3b  changed Compose config redeploys the live commit once"
before="$run"
yq -i '.MODE = "updated"' "${fleet}/servers/${server}/apps/sample.yml"
upgrade apps
run="$(await_run "$before")"
[ "$(state_of "$run")" = success ] || die "the Compose configuration redeploy failed"
[ "$(awk '{print $3}' <<< "$run")" = "$(awk '{print $3}' <<< "$before")" ] ||
    die "the Compose configuration redeploy switched commits"
multipass exec "$vm_name" -- sudo docker exec sample-web-1 printenv MODE | grep -qx updated ||
    die "the live Compose container has the old configuration"
upgrade apps
[ "$(newest_run)" = "$run" ] || die "unchanged Compose registration redeployed the app"
expect_serves v3
echo "✓ changed Compose config reached the same release, and an unchanged registration left it running"

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
expect_serves v3

# ── 5: rollback, GC, verify ─────────────────────────────────────────────────
step "5  rollback to v2, the registry GC, kayra verify"
ctl rollback sample | grep -q "^  ${v2}" || die "the deployer does not list v2 (${v2}) as an earlier release"
kayra_cmd app rollback "$server" sample | grep -q " live$" || die "kayra app rollback prints the releases undrawn"
echo "✓ kayra app rollback draws the releases"
before="$run"
kayra_cmd app rollback "$server" sample "$v2" >> "$log" 2>&1
run="$(await_run "$before")"
[ "$(state_of "$run")" = success ] || die "the rollback: ${run}"
expect_serves v2
kayra_cmd job "$server" gc >> "$log" 2>&1
for _ in $(seq 1 12); do
    kayra_cmd app logs "$server" gc 2>/dev/null | grep -q "Total reclaimed space" && break
    sleep 5
done
kayra_cmd app logs "$server" gc | grep -q "Total reclaimed space" || die "the registry GC did not run through"
echo "✓ the registry GC ran"
kayra_cmd verify "$server" || die "kayra verify after the scenario"

# ── 6: a server that takes no webhooks ─────────────────────────────────────
step "6  webhooks: false — no /hook, and the poll alone deploys a push"
yq -i '.webhooks = false | .deploy_poll = "*/2 * * * *"' "${fleet}/servers/${server}/vars.yml"
verified="$(kayra_cmd deploy "$server" 2>&1)" || { printf '%s\n' "$verified" >> "$log"; die "kayra deploy with webhooks: false"; }
printf '%s\n' "$verified" >> "$log"
grep -q "webhooks are off: /hook is not served" <<< "$verified" || die "verify does not see /hook gone"
echo "✓ webhooks: false serves no /hook, and verify knows it"
multipass exec "$vm_name" -- cat /opt/platform/apps/sample.json | jq -e '.runtime == "compose"' >/dev/null || die "registration did not record the Compose runtime"
echo "✓ registration records the Compose runtime"
yq -i 'del(.services.web.volumes)' "${repo}/deploy/compose.yml"
echo v4 > "${repo}/web/index.html"
commit v4
before="$run"
run="$(await_run "$before")"
[ "$(state_of "$run")" = success ] || die "the polled deploy of v4: ${run}"
grep -q " poll " <<< "$run" || die "v4 deployed, but not by the poll: ${run}"
expect_serves v4
echo "✓ a push with no webhook deployed by deploy_poll"

if [ "$swarm_host" = true ] || [ "$managed_fleet" = true ] || [ "$managed_forward" = true ] || [ "$managed_workers" = true ]; then
    step "6a  explicit Swarm host setup alongside Compose"
    KAYRA_LAB_ADVERTISE_ADDRESS="$address" yq -i '.experimental_swarm = {
        "enabled": true, "advertise_address": strenv(KAYRA_LAB_ADVERTISE_ADDRESS),
        "memory_bytes": 3221225472, "cpu_millicores": 2000,
        "platform_memory_bytes": 1073741824, "platform_cpu_millicores": 500
    }' "${fleet}/servers/${server}/vars.yml"
    if [ "$managed_fleet" = true ] || [ "$managed_forward" = true ] || [ "$managed_workers" = true ]; then
        yq -i '.managed_swarm_rollouts = true' "${fleet}/servers/${server}/vars.yml"
    fi
    kayra_cmd plan "$server" >> "$log" 2>&1 || die "previewing explicit Swarm setup"
    [ "$(multipass exec "$vm_name" -- sudo docker info --format '{{.Swarm.LocalNodeState}}')" = inactive ] || die "Swarm preview changed membership"
    kayra_cmd setup "$server" >> "$log" 2>&1 || die "explicit Swarm host setup"
fi

if [ "$managed_fleet" = true ]; then
    step "6b  production-style opt-in registration and HTTPS rollout"
    fleet_repo="${work}/managed-fleet"
    cp -R "${KAYRA_ROOT}/test/lab/app" "$fleet_repo"
    yq -i '.name = "managed-fleet" | .routes[0].host = "managed-fleet" | .routes[0].check = "/" |
        del(.secrets) | .rollout = {"strategy": "rolling", "mixed_version_compatible": true, "rollback_compatible": true,
        "services": {"web": {"role": "http", "overlap": "allowed"}}}' "$fleet_repo/app.yml"
    yq -i 'del(.services.web.mem_limit, .services.web.environment.GREETING) |
        .services.web.deploy.resources = {"limits": {"memory": "64m", "cpus": "0.1"}, "reservations": {"memory": "32m", "cpus": "0.05"}} |
        .services.web.volumes = [{"type":"volume", "source":"fixture-data", "target":"/data", "volume":{"nocopy":true}}] |
        .volumes = {"fixture-data": {}} |
        .services.web.healthcheck = {"test": ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"], "interval": "1s", "timeout": "1s", "start_period": "1s", "retries": 3} |
        .services.web.stop_grace_period = "30s"' "$fleet_repo/deploy/compose.yml"
    jq '.image = "managed-fleet/web"' "$fleet_repo/web/docker/image.json" > "${work}/managed-fleet-image.json"
    mv "${work}/managed-fleet-image.json" "$fleet_repo/web/docker/image.json"
    printf 'fleet-managed\n' > "$fleet_repo/web/index.html"
    git -C "$fleet_repo" init -q -b main
    git -C "$fleet_repo" add -A
    git -C "$fleet_repo" -c user.name="Kayra lab" -c user.email=lab@kayra.test -c commit.gpgsign=false commit -qm "managed fleet registration fixture"
    git clone -q --bare "$fleet_repo" "${served}/lab/managed-fleet.git"
    fleet_commit="$(git -C "$fleet_repo" rev-parse HEAD)"
    FLEET_REPO="http://${host_ip}:${port}/lab/managed-fleet.git" yq -i '.apps += [{"name": "managed-fleet", "ref": "main", "path": ".", "repo": strenv(FLEET_REPO),
        "runtime": "swarm", "grants": {"memory_bytes": 268435456, "cpu_millicores": 500, "maintenance": false}}]' "${fleet}/servers/${server}/server.yml"
    # The managed app must have its own operator config; it cannot inherit MODE from sample.
    kayra_cmd apps "$server" >> "$log" 2>&1 && die "managed fixture registered without its own configuration"
    printf 'MODE: managed\n' > "${fleet}/servers/${server}/apps/managed-fleet.yml"
    kayra_cmd apps "$server" >> "$log" 2>&1 || die "registering the managed fixture through fleet configuration"
    ctl registration policy managed-fleet | jq -e '.runtime == "swarm"' >/dev/null || die "fleet registration did not select Swarm"
    ctl build managed-fleet "$fleet_commit" | jq -e --arg commit "$fleet_commit" '.commit == $commit' >/dev/null || die "managed fleet build receipt"
    fleet_request="$(python3 -c 'import uuid; print(uuid.uuid4())')"
    ctl lifecycle prepare managed-fleet "$fleet_commit" "$fleet_request" | jq -e --arg run "$fleet_request" '.version == 3 and .request == $run' >/dev/null || die "managed fleet deployment acceptance"
    await_fleet_release() {
        local request="$1" commit="$2" report="$3"
        await_managed_phase managed-fleet "$request" complete "$report"
        jq -e --arg sha "$commit" '.operation.outcome == "deployed" and .verifiedActive.commit == $sha' "$report" >/dev/null ||
            die "managed fleet release did not converge"
    }
    await_fleet_release "$fleet_request" "$fleet_commit" "${work}/fleet-status.json"
    fleet_container() {
        local id
        id="$(multipass exec "$vm_name" -- sudo docker ps --filter 'label=com.kayra.app=managed-fleet' --filter 'label=com.kayra.service=web' --format '{{.ID}}')"
        [[ "$id" =~ ^[a-f0-9]{12,64}$ ]] || die "the managed fixture did not have exactly one running web task"
        printf '%s\n' "$id"
    }
    fleet_volume() {
        multipass exec "$vm_name" -- sudo docker inspect "$(fleet_container)" --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}'
    }
    data_volume="$(fleet_volume)"
    [[ "$data_volume" =~ ^kayra-data-[a-f0-9-]{36}$ ]] || die "fixture volume was not owned by Kayra"
    data_birth="$(multipass exec "$vm_name" -- sudo docker volume inspect "$data_volume" --format '{{.CreatedAt}}')"
    multipass exec "$vm_name" -- sudo docker exec "$(fleet_container)" sh -ec 'echo previous-incarnation > /data/marker'
    expect_fleet_data() {
        [ "$(fleet_volume)" = "$data_volume" ] || die "managed data allocation changed"
        [ "$(multipass exec "$vm_name" -- sudo docker volume inspect "$data_volume" --format '{{.CreatedAt}}')" = "$data_birth" ] || die "managed volume birth changed"
        [ "$(multipass exec "$vm_name" -- sudo docker exec "$(fleet_container)" cat /data/marker)" = previous-incarnation ] || die "managed data did not survive"
    }
    routed="$(curl -sf -m 10 --resolve "managed-fleet.${domain}:443:${address}" "https://managed-fleet.${domain}/" | tr -d '\n')"
    [ "$routed" = fleet-managed ] || die "the managed fleet release was not routed"
    ctl runs managed-fleet --json | jq -e --arg run "$fleet_request" '.protocol == "managed-v3" and (.runs[0] | .id == $run and .managed.outcome == "deployed")' >/dev/null || die "fleet rollout did not reach run reporting"

    printf 'fleet-successor\n' > "$fleet_repo/web/index.html"
    git -C "$fleet_repo" add -A
    git -C "$fleet_repo" -c user.name="Kayra lab" -c user.email=lab@kayra.test -c commit.gpgsign=false commit -qm "managed fleet successor"
    git -C "$fleet_repo" push -q "${served}/lab/managed-fleet.git" HEAD:refs/heads/main
    fleet_successor="$(git -C "$fleet_repo" rev-parse HEAD)"
    ctl build managed-fleet "$fleet_successor" | jq -e --arg commit "$fleet_successor" '.commit == $commit' >/dev/null || die "managed successor build"
    successor_request="$(python3 -c 'import uuid; print(uuid.uuid4())')"
    ctl lifecycle prepare managed-fleet "$fleet_successor" "$successor_request" >/dev/null || die "managed successor acceptance"
    await_fleet_release "$successor_request" "$fleet_successor" "${work}/fleet-successor.json"
    expect_fleet_data
    restore_record="$(jq -er --arg sha "$fleet_commit" '.previousRelease | select(.commit == $sha) | .record' "${work}/fleet-successor.json")"
    restore_request="$(python3 -c 'import uuid; print(uuid.uuid4())')"
    ctl lifecycle restore managed-fleet "$restore_record" "$restore_request" >/dev/null || die "managed restore acceptance"
    await_fleet_release "$restore_request" "$fleet_commit" "${work}/fleet-restored.json"
    expect_fleet_data
    restored="$(curl -sf -m 10 --resolve "managed-fleet.${domain}:443:${address}" "https://managed-fleet.${domain}/" | tr -d '\n')"
    [ "$restored" = fleet-managed ] || die "the restored managed release was not routed"
    ctl runs managed-fleet --json | jq -e --arg run "$restore_request" '.runs[0] | .id == $run and .why == "restore" and .managed.outcome == "deployed"' >/dev/null || die "managed restore history"
    expect_serves v4
    kayra_cmd verify "$server" >> "$log" 2>&1 || die "mixed-runtime fleet verification"
    cp "${fleet}/servers/${server}/server.yml" "${work}/fleet-managed-registered.yml"
    yq -i '.apps |= map(select(.name != "managed-fleet"))' "${fleet}/servers/${server}/server.yml"
    kayra_cmd apps "$server" >> "$log" 2>&1 || die "retiring the managed fleet app"
    ctl lifecycle status managed-fleet > "${work}/fleet-removed.json"
    jq -e '.lifecycle == "removed" and .verifiedActive == null' "${work}/fleet-removed.json" >/dev/null || die "managed fleet removal status"
    step "6c  explicitly recreate the managed app with its original data"
    recreate_request="$(python3 -c 'import uuid; print(uuid.uuid4())')"
    removal="$(jq -er '.retirement.request' "${work}/fleet-removed.json")"
    cp "${work}/fleet-managed-registered.yml" "${fleet}/servers/${server}/server.yml"
    kayra_cmd app deployment recreate "$server" managed-fleet "$removal" "$recreate_request" --reason "Reopen the verified fixture data" >> "$log" 2>&1 ||
        die "managed fixture recreation"
    await_fleet_release "$recreate_request" "$fleet_commit" "${work}/fleet-recreated.json"
    [ "$(jq -r '.incarnation' "${work}/fleet-recreated.json")" != "$(jq -r '.incarnation' "${work}/fleet-status.json")" ] || die "managed recreation reused its workload owner"
    expect_fleet_data
    [ "$(curl -sf -m 10 --resolve "managed-fleet.${domain}:443:${address}" "https://managed-fleet.${domain}/" | tr -d '\n')" = fleet-managed ] ||
        die "the recreated verified release was not routed"
    kayra_cmd apps "$server" >> "$log" 2>&1 || die "ordinary registration replay after recreation"
    await_fleet_release "$recreate_request" "$fleet_commit" "${work}/fleet-recreated.json"
    expect_fleet_data
    ctl runs managed-fleet --json | jq -e --arg run "$recreate_request" '.runs[0] | .id == $run and .why == "recreate" and .managed.outcome == "deployed"' >/dev/null || die "managed recreation history"
    yq -i '.apps |= map(select(.name != "managed-fleet"))' "${fleet}/servers/${server}/server.yml"
    kayra_cmd apps "$server" >> "$log" 2>&1 || die "retiring the recreated managed app"
    multipass exec "$vm_name" -- sudo /opt/platform/bin/app-purge managed-fleet >> "$log" 2>&1 || die "purging the disposable managed fleet app"
    ctl lifecycle status managed-fleet > "${work}/fleet-purged.json"
    jq -e '.lifecycle == "purged" and .retirement.remainingVolumes == 0' "${work}/fleet-purged.json" >/dev/null || die "managed fleet purge status"
    if multipass exec "$vm_name" -- sudo docker volume inspect "$data_volume" >> "$log" 2>&1; then die "purged fixture volume is still present"; fi
    expect_serves v4
    kayra_cmd verify "$server" >> "$log" 2>&1 || die "Compose verification after managed fleet retirement"
    for stage in status successor restored removed recreated purged; do
        install -m 600 "${work}/fleet-${stage}.json" "/tmp/kayra-swarm-platform-${vm_name}.fleet-${stage}.json"
    done
    echo "✓ an explicitly enabled fleet registered, deployed, restored, removed, recreated and purged Swarm alongside its Compose app"
fi

if [ "$managed_forward" = true ]; then
    step "6b  audited forward recovery after an incompatible migration"
    forward_repo="${work}/managed-forward"
    cp -R "${KAYRA_ROOT}/test/lab/swarm-platform/forward-fixture" "$forward_repo"
    git -C "$forward_repo" init -q -b main
    forward_commit() {
        git -C "$forward_repo" add -A
        git -C "$forward_repo" -c user.name="Kayra lab" -c user.email=lab@kayra.test -c commit.gpgsign=false commit -qm "$1"
        git -C "$forward_repo" rev-parse HEAD
    }
    forward_base="$(forward_commit "Application before the new schema")"
    git clone -q --bare "$forward_repo" "${served}/lab/managed-forward.git"
    FLEET_REPO="http://${host_ip}:${port}/lab/managed-forward.git" yq -i '.apps += [{"name": "managed-forward", "ref": "main", "path": ".", "repo": strenv(FLEET_REPO),
        "runtime": "swarm", "grants": {"memory_bytes": 402653184, "cpu_millicores": 750, "maintenance": true}}]' "${fleet}/servers/${server}/server.yml"
    kayra_cmd apps "$server" >> "$log" 2>&1 || die "registering the forward recovery fixture"
    forward_prepare() {
        ctl build managed-forward "$1" | jq -e --arg commit "$1" '.commit == $commit' >/dev/null || die "retaining the forward lab build"
        ctl lifecycle prepare managed-forward "$1" "$2" | jq -e --arg run "$2" '.version == 3 and .request == $run' >/dev/null || die "accepting the forward lab deployment"
    }
    forward_response() {
        curl -sf -m 10 --resolve "forward.${domain}:443:${address}" "https://forward.${domain}/version"
    }
    forward_run_a="$(new_uuid)"
    forward_prepare "$forward_base" "$forward_run_a"
    await_managed_phase managed-forward "$forward_run_a" complete "${work}/forward-baseline.json"
    forward_response | jq -e '.release == "A" and .schema == 1' >/dev/null || die "forward fixture baseline"
    maintenance_requests="${work}/forward-maintenance.jsonl"
    python3 -B "${KAYRA_ROOT}/test/lab/swarm-platform/maintenance-http.py" "$address" "forward.${domain}" "$maintenance_requests" >> "$log" 2>&1 &
    maintenance_pid=$!
    for _ in $(seq 1 50); do
        [ ! -s "$maintenance_requests" ] || break
        kill -0 "$maintenance_pid" 2>/dev/null || die "the maintenance observer exited before sampling"
        sleep 0.1
    done
    [ -s "$maintenance_requests" ] || die "the maintenance observer did not sample the baseline"
    database_id() {
        multipass exec "$vm_name" -- sudo docker ps --filter 'label=com.kayra.app=managed-forward' --filter 'label=com.kayra.service=db' --format '{{.ID}}'
    }
    db_before="$(database_id)"
    [[ "$db_before" =~ ^[a-f0-9]{12,64}$ ]] || die "the forward fixture did not have exactly one running database task"

    yq -i '.rollout.strategy = "maintenance" | .rollout.mixed_version_compatible = false | .rollout.rollback_compatible = false |
        .rollout.migrations = [{"id":"schema", "service":"web", "command":["node","/fixture.mjs","migrate"], "timeout_seconds":30,
            "recovery":{"kind":"status-probe","command":["node","/fixture.mjs","probe"],"timeout_seconds":10}}] |
        .rollout.checks = [{"id":"application", "service":"web", "command":["node","/fixture.mjs","check"], "timeout_seconds":10}]' "$forward_repo/app.yml"
    yq -i '.services.web.environment = {"RELEASE":"B", "SCHEMA":"2", "CHECK_FAIL":"true"}' "$forward_repo/deploy/compose.yml"
    forward_b="$(forward_commit "Apply the incompatible schema and block release certification")"
    git -C "$forward_repo" push -q "${served}/lab/managed-forward.git" HEAD:refs/heads/main
    forward_run_b="$(new_uuid)"
    forward_prepare "$forward_b" "$forward_run_b"
    await_managed_phase managed-forward "$forward_run_b" held "${work}/forward-migration-unknown.json"
    jq -e '.compatibilityEpoch == 1 and .rollback == "data-fenced" and .verifiedActive == null and
        .migrations.phase == "held" and .migrations.reason == "probe-unknown" and .migrations.step == "schema"' "${work}/forward-migration-unknown.json" >/dev/null ||
        die "forward fixture did not hold an ambiguous migration"
    multipass exec "$vm_name" -- sudo docker exec "$db_before" cat /data/ledger.json |
        jq -e --arg operation "$forward_run_b:schema" '.schema == 2 and .attempts == [$operation]' >/dev/null ||
        die "the fixture database did not prove the migration outcome"
    kayra_cmd app migration resolve "$server" managed-forward "$forward_run_b" schema applied --reason "Verified the fixture schema and exact operation in the retained ledger" >> "$log" 2>&1 ||
        die "recording the ambiguous migration outcome through the operator CLI"
    # The same run briefly remains visible as held while command and observer reconcile.
    for _ in $(seq 1 45); do
        ctl lifecycle status managed-forward > "${work}/forward-held.json"
        if jq -e --arg run "$forward_run_b" '.operation.run == $run and .operation.phase == "held" and .operation.reason != "preparation"' "${work}/forward-held.json" >/dev/null; then break; fi
        sleep 2
    done
    install -m 600 "${work}/forward-held.json" "/tmp/kayra-swarm-platform-${vm_name}.forward-held.json"
    audit_query="$(jq -nc --arg run "$forward_run_b" '{app:"managed-forward",run:$run,step:"schema"}' |
        python3 -c 'import base64,sys;print(base64.urlsafe_b64encode(sys.stdin.buffer.read()).decode().rstrip("="))')"
    ctl migration audit "$audit_query" > "${work}/forward-migration-audit.json" ||
        die "reading audited resolution through deployed control"
    jq -e --arg run "$forward_run_b" '.audit.scope.run == $run and .audit.scope.step == "schema" and
        .audit.outcome == "applied" and .audit.actor.kind == "operator-control"' "${work}/forward-migration-audit.json" >/dev/null ||
        die "audit did not bind the operator outcome to the migration"
    install -m 600 "${work}/forward-migration-audit.json" "/tmp/kayra-swarm-platform-${vm_name}.forward-migration-audit.json"
    jq -e '.compatibilityEpoch == 1 and .rollback == "data-fenced" and .verifiedActive == null and
        .migrations.phase == "succeeded" and .operation.reason == "verification" and
        (.migrations.resolutions | any(.step == "schema" and .outcome == "applied"))' "${work}/forward-held.json" >/dev/null ||
        die "forward fixture did not hold at the incompatible data epoch"
    [ "$(database_id)" = "$db_before" ] || die "maintenance replaced the retained dependency"
    multipass exec "$vm_name" -- sudo docker exec "$db_before" cat /data/ledger.json |
        jq -e --arg operation "$forward_run_b:schema" '.schema == 2 and .attempts == [$operation]' >/dev/null ||
        die "fixture migration did not persist exactly one attempt"

    yq -i 'del(.rollout.migrations) | .rollout.rollback_compatible = true' "$forward_repo/app.yml"
    yq -i '.services.web.environment = {"RELEASE":"C", "SCHEMA":"2", "CHECK_FAIL":"false"}' "$forward_repo/deploy/compose.yml"
    forward_c="$(forward_commit "Forward repair compatible with the retained schema")"
    git -C "$forward_repo" push -q "${served}/lab/managed-forward.git" HEAD:refs/heads/main
    forward_run_c="$(new_uuid)"
    forward_reason="Deploy the reviewed fixture repair for schema two"
    kayra_cmd app deployment forward "$server" managed-forward "$forward_run_b" "$forward_c" "$forward_run_c" --reason "$forward_reason" >> "$log" 2>&1 ||
        die "accepting audited forward recovery through the operator CLI"
    kayra_cmd ssh "$server" -- cd /opt/platform '&&' docker compose kill -s SIGKILL deployer >> "$log" 2>&1 ||
        die "interrupting the disposable deployer after forward acceptance"
    kayra_cmd ssh "$server" -- cd /opt/platform '&&' docker compose up -d deployer >> "$log" 2>&1 ||
        die "restarting the disposable deployer"
    await_managed_phase managed-forward "$forward_run_c" complete "${work}/forward-recovered.json"
    jq -e --arg commit "$forward_c" '.compatibilityEpoch == 1 and .verifiedActive.commit == $commit and .operation.outcome == "deployed"' "${work}/forward-recovered.json" >/dev/null ||
        die "forward recovery did not certify the requested release"
    [ "$(database_id)" = "$db_before" ] || die "forward recovery replaced the retained dependency"
    multipass exec "$vm_name" -- sudo docker exec "$db_before" cat /data/ledger.json > "${work}/forward-ledger.json"
    jq -e --arg operation "$forward_run_b:schema" '.schema == 2 and .attempts == [$operation]' "${work}/forward-ledger.json" >/dev/null || die "forward recovery repeated a migration"
    install -m 600 "${work}/forward-ledger.json" "/tmp/kayra-swarm-platform-${vm_name}.forward-ledger.json"
    forward_response | jq -e '.release == "C" and .schema == 2' >/dev/null || die "forward fixture repair is not routed"
    ctl runs managed-forward --json | jq -e --arg run "$forward_run_c" '.runs[0] | .id == $run and .why == "forward recovery" and .managed.outcome == "deployed"' >/dev/null ||
        die "forward recovery run history"
    kayra_cmd app deployment forward "$server" managed-forward "$forward_run_b" "$forward_c" "$forward_run_c" --reason "$forward_reason" >> "$log" 2>&1 ||
        die "replaying the accepted forward recovery"
    await_managed_phase managed-forward "$forward_run_c" complete "${work}/forward-recovered.json"
    expect_serves v4
    kayra_cmd verify "$server" >> "$log" 2>&1 || die "fleet verification after forward recovery"
    maintenance_result=0
    wait "$maintenance_pid" || maintenance_result=$?
    maintenance_pid=
    for suffix in jsonl summary.json; do
        install -m 600 "${work}/forward-maintenance.${suffix}" "/tmp/kayra-swarm-platform-${vm_name}.forward-maintenance.${suffix}"
    done
    [ "$maintenance_result" -eq 0 ] || die "maintenance did not show the expected HTTP interruption and stable repair"
    echo "✓ audited forward recovery repaired a fenced deployment after a deployer restart using the original retained data"
fi

if [ "$managed_workers" = true ]; then
    step "6c  app-owned worker drain, redelivery and effects across Swarm rollout"
    worker_repo="${work}/managed-workers"
    cp -R "${KAYRA_ROOT}/test/lab/swarm-platform/worker-fixture" "$worker_repo"
    git -C "$worker_repo" init -q -b main
    worker_commit() {
        git -C "$worker_repo" add -A
        git -C "$worker_repo" -c user.name="Kayra lab" -c user.email=lab@kayra.test -c commit.gpgsign=false commit -qm "$1"
        git -C "$worker_repo" rev-parse HEAD
    }
    worker_a="$(worker_commit "Worker A drains and deduplicates through the application ledger")"
    yq -i '.services.worker.environment.RELEASE = "B" | .services.worker.environment.IDEMPOTENT = "false"' "$worker_repo/deploy/compose.yml"
    worker_b="$(worker_commit "Worker B has no effect deduplication")"
    yq -i '.services.worker.environment.RELEASE = "C" | .services.worker.environment.IDEMPOTENT = "true"' "$worker_repo/deploy/compose.yml"
    worker_c="$(worker_commit "Worker C deduplicates repeat effects in the application")"
    git clone -q --bare "$worker_repo" "${served}/lab/managed-workers.git"
    # Budget the retained 192 MiB database and three 128 MiB worker slots
    # conservatively for recovery, even though ordinary replacement is stop-first.
    FLEET_REPO="http://${host_ip}:${port}/lab/managed-workers.git" yq -i '.apps += [{"name": "managed-workers", "ref": "main", "path": ".", "repo": strenv(FLEET_REPO),
        "runtime": "swarm", "grants": {"memory_bytes": 671088640, "cpu_millicores": 1000, "maintenance": false}}]' "${fleet}/servers/${server}/server.yml"
    SOPS_AGE_KEY_FILE="${work}/age-key.txt" sops set "servers/${server}/secrets.yml" '["app_secrets"]["managed-workers"]'         '{"POSTGRES_PASSWORD":"lab-only-worker","DATABASE_URL":"postgres://lab:lab-only-worker@db:5432/lab"}' >> "$log" 2>&1 ||
        die "writing disposable worker fixture secrets"
    kayra_cmd apps "$server" >> "$log" 2>&1 || die "registering the managed worker fixture"
    for release in "$worker_a" "$worker_b" "$worker_c"; do
        ctl build managed-workers "$release" | jq -e --arg sha "$release" '.commit == $sha' >/dev/null || die "retaining a worker release"
    done
    worker_deploy() {
        ctl lifecycle prepare managed-workers "$1" "$2" | jq -e --arg run "$2" '.version == 3 and .request == $run' >/dev/null || die "accepting managed worker deployment"
    }
    worker_status() {
        local commit="$1" run="$2" report="$3"
        await_managed_phase managed-workers "$run" complete "$report"
        jq -e --arg commit "$commit" '.verifiedActive.commit == $commit and .operation.outcome == "deployed"' "$report" >/dev/null ||
            die "worker release did not verify"
    }
    worker_container() {
        local id
        id="$(multipass exec "$vm_name" -- sudo docker ps --filter 'label=com.kayra.app=managed-workers' --filter "label=com.kayra.service=$1" --format '{{.ID}}')"
        [[ "$id" =~ ^[a-f0-9]{12,64}$ ]] || die "expected one running worker fixture $1 container"
        printf '%s\n' "$id"
    }
    worker_sql() {
        python3 - "$vm_name" "$worker_db" "$1" <<'PYTHON'
import subprocess
import sys

vm, container, statement = sys.argv[1:]
result = subprocess.run(
    ["multipass", "exec", vm, "--", "sudo", "docker", "exec", container,
     "psql", "-U", "lab", "-d", "lab", "-X", "-v", "ON_ERROR_STOP=1", "-Atc", statement],
    stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=10, check=False,
)
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
raise SystemExit(result.returncode)
PYTHON
    }
    wait_worker_sql() {
        local query="$1" description="$2"
        for _ in $(seq 1 120); do
            [ "$(worker_sql "$query")" != t ] || return 0
            sleep 0.25
        done
        die "$description"
    }
    worker_run_a="$(new_uuid)"
    printf '%s\n' "$worker_run_a" > "${work}/worker-request-a.txt"
    worker_deploy "$worker_a" "$worker_run_a"
    worker_status "$worker_a" "$worker_run_a" "${work}/worker-baseline.json"
    worker_db="$(worker_container db)"
    worker_old="$(worker_container worker)"
    worker_service="$(multipass exec "$vm_name" -- sudo docker inspect "$worker_old" --format '{{ index .Config.Labels "com.docker.swarm.service.id" }}')"
    [[ "$worker_service" =~ ^[a-z0-9]{25}$ ]] || die "worker service identity"
    worker_sql "INSERT INTO jobs(id,duration_ms) VALUES (0,18000)" >/dev/null
    wait_worker_sql "SELECT EXISTS (SELECT 1 FROM history WHERE job_id=0 AND kind='claimed' AND release='A')" "worker A never claimed the drain fixture"
    worker_run_b="$(new_uuid)"
    printf '%s\n' "$worker_run_b" > "${work}/worker-request-b.txt"
    worker_deploy "$worker_b" "$worker_run_b"
    worker_status "$worker_b" "$worker_run_b" "${work}/worker-stop-first.json"
    [ "$(multipass exec "$vm_name" -- sudo docker service inspect "$worker_service" --format '{{.Spec.UpdateConfig.Order}}')" = stop-first ] || die "worker update order is not stop-first"
    [ "$(worker_sql "SELECT exists (SELECT 1 FROM jobs WHERE id=0 AND state='done' AND attempts=1) AND
        (SELECT max(id) FROM history WHERE kind='claimed' AND job_id=0 AND release='A') <
        (SELECT min(id) FROM history WHERE kind='shutdown-requested' AND release='A') AND
        (SELECT max(id) FROM history WHERE kind='shutdown-requested' AND release='A') <
        (SELECT min(id) FROM history WHERE kind='acknowledged' AND job_id=0 AND release='A') AND
        (SELECT max(id) FROM history WHERE kind='acknowledged' AND job_id=0 AND release='A') <
        (SELECT min(id) FROM history WHERE kind='drained' AND release='A') AND
        (SELECT max(id) FROM history WHERE kind='drained' AND release='A') <
        (SELECT min(id) FROM history WHERE kind='started' AND release='B')")" = t ] ||
        die "worker A did not acknowledge and drain before B started"

    redeliver_worker_job() {
        local job="$1" table="$2" expected="$3" killed report
        worker_sql "INSERT INTO jobs(id,duration_ms,pause_after_effect) VALUES ($job,100,true)" >/dev/null
        wait_worker_sql "SELECT EXISTS (SELECT 1 FROM history WHERE job_id=$job AND kind='before-ack-paused')" "worker never reached the post-effect crash point"
        killed="$(worker_container worker)"
        multipass exec "$vm_name" -- sudo docker kill --signal SIGKILL "$killed" >> "$log" 2>&1 || die "killing the disposable worker task"
        wait_worker_sql "SELECT EXISTS (SELECT 1 FROM jobs WHERE id=$job AND state='done')" "worker lease did not redeliver and settle the job"
        [ "$(worker_sql "SELECT (SELECT attempts FROM jobs WHERE id=$job)=2 AND
            (SELECT count(DISTINCT task) FROM history WHERE job_id=$job AND kind='claimed')=2 AND
            (SELECT count(*) FROM $table WHERE job_id=$job)=$expected AND
            (SELECT count(*) FROM history WHERE job_id=$job AND kind='acknowledged')=1")" = t ] ||
            die "redelivered worker job evidence disagrees"
        report="${work}/worker-delivery-${job}.json"
        worker_sql "SELECT json_build_object('job',(SELECT row_to_json(j) FROM jobs j WHERE id=$job),
            'history',(SELECT json_agg(h ORDER BY id) FROM history h WHERE job_id=$job),
            'effects',(SELECT json_agg(e ORDER BY attempt) FROM $table e WHERE job_id=$job))" > "$report"
        install -m 600 "$report" "/tmp/kayra-swarm-platform-${vm_name}.$(basename "$report")"
    }
    redeliver_worker_job 1 raw_effects 2
    worker_run_c="$(new_uuid)"
    printf '%s\n' "$worker_run_c" > "${work}/worker-request-c.txt"
    worker_deploy "$worker_c" "$worker_run_c"
    worker_status "$worker_c" "$worker_run_c" "${work}/worker-idempotent.json"
    redeliver_worker_job 2 effects 1
    [ "$(worker_container db)" = "$worker_db" ] || die "worker updates replaced the retained database"
    worker_sql "SELECT json_agg(history ORDER BY id) FROM history" > "${work}/worker-history.json"
    install -m 600 "${work}/worker-history.json" "/tmp/kayra-swarm-platform-${vm_name}.worker-history.json"
    expect_serves v4
    kayra_cmd verify "$server" >> "$log" 2>&1 || die "fleet verification after worker replacements"
    echo "✓ the stop-first worker drained before replacement and redelivered killed jobs with app-owned effect handling"
fi

if [ "$swarm_host" = true ]; then
    ANSIBLE_CONFIG="${KAYRA_ROOT}/ansible/ansible.cfg" \
        ANSIBLE_LIBRARY="${KAYRA_ROOT}/ansible/roles/platform/library" ansible-playbook \
        -i "servers/${server}/inventory.ini" \
        "${KAYRA_ROOT}/test/lab/swarm-platform/live.yml" \
        -e "kayra_root=${KAYRA_ROOT}" -e "report_path=${work}/swarm-platform.json" >> "$log" 2>&1 || die "mixed Compose and Swarm routing"
    ANSIBLE_CONFIG="${KAYRA_ROOT}/ansible/ansible.cfg" ansible-playbook \
        -i "servers/${server}/inventory.ini" \
        "${KAYRA_ROOT}/test/lab/swarm-platform/http-coordinator.yml" \
        -e "kayra_root=${KAYRA_ROOT}" -e "report_path=${work}/http-coordinator.json" >> "$log" 2>&1 || die "durable HTTP coordinator component"
    cp "${work}/http-coordinator.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.json"
    cp "${work}/http-coordinator.json.source.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.source.json"
    cp "${work}/http-coordinator.json.overlap.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.overlap.json"
    cp "${work}/http-coordinator.json.overlap.native.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.overlap.native.json"
    cp "${work}/http-coordinator.json.jobs.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.jobs.json"
    cp "${work}/http-coordinator.json.jobs.tar" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.jobs.tar"
    cp "${work}/http-coordinator.json.probes.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.probes.json"
    cp "${work}/http-coordinator.json.probes.tar" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.probes.tar"
    cp "${work}/http-coordinator.json.cold.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.cold.json"
    cp "${work}/http-coordinator.json.cold.tar" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.cold.tar"
    cp "${work}/http-coordinator.json.deadlines.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.deadlines.json"
    cp "${work}/http-coordinator.json.deadlines.tar" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.deadlines.tar"
    cp "${work}/http-coordinator.json.sequence.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.sequence.json"
    cp "${work}/http-coordinator.json.sequence.tar" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.sequence.tar"
    cp "${work}/http-coordinator.json.indexed-sequence.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.indexed-sequence.json"
    cp "${work}/http-coordinator.json.indexed-sequence.tar" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.indexed-sequence.tar"
    cp "${work}/http-coordinator.json.rollout.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.rollout.json"
    cp "${work}/http-coordinator.json.rollout.tar" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.rollout.tar"
    cp "${work}/http-coordinator.json.unstarted.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.unstarted.json"
    cp "${work}/http-coordinator.json.unstarted.tar" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.unstarted.tar"
    cp "${work}/http-coordinator.json.host.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.host.json"
    cp "${work}/http-coordinator.json.host.tar" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.host.tar"
    cp "${work}/http-coordinator.json.resolution.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.resolution.json"
    cp "${work}/http-coordinator.json.resolution.tar" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.resolution.tar"
    cp "${work}/http-coordinator.json.job-health.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.job-health.json"
    cp "${work}/http-coordinator.json.job-health.tar" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.job-health.tar"
    cp "${work}/http-coordinator.json.job-cleanup.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.job-cleanup.json"
    cp "${work}/http-coordinator.json.job-cleanup.tar" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.job-cleanup.tar"
    cp "${work}/http-coordinator.json.migration-cleanup.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.migration-cleanup.json"
    cp "${work}/http-coordinator.json.migration-cleanup.tar" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.migration-cleanup.tar"
    cp "${work}/http-coordinator.json.cancellation.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.cancellation.json"
    cp "${work}/http-coordinator.json.cancellation.tar" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.cancellation.tar"
    cp "${work}/http-coordinator.json.handoff-expiry.json" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.handoff-expiry.json"
    cp "${work}/http-coordinator.json.handoff-expiry.tar" "/tmp/kayra-swarm-platform-${vm_name}.coordinator.handoff-expiry.tar"
    cp "${work}/swarm-platform.json" "/tmp/kayra-swarm-platform-${vm_name}.json"
    cp "${work}/swarm-platform.json.native.json" "/tmp/kayra-swarm-platform-${vm_name}.native.json"
    cp "${work}/swarm-platform.json.adapter.json" "/tmp/kayra-swarm-platform-${vm_name}.adapter.json"
    echo "✓ Swarm discovery is read-only; Compose and Swarm serve with verified TLS"
    echo "  exact versions and results: /tmp/kayra-swarm-platform-${vm_name}.json"
    expect_serves v4
    kayra_cmd verify "$server" || die "platform verification after Swarm host setup"
fi

if [ "$indexed_registration" = true ]; then
    prepare_admission_inputs() {
        local prefix="$1" inputs="$2" memory="$3" bytes="$4" managed=false
        local admission_app admission_repo admission_commit admission_request
        [ -z "$prefix" ] || managed=true
        jq -n --argjson managed "$managed" --argjson memory "$bytes" '
            {admission_applications: [], admission_managed: $managed, admission_memory: $memory}
        ' > "$inputs"
        for admission_app in "${prefix}admission-left" "${prefix}admission-right"; do
            admission_repo="${work}/${admission_app}"
            cp -R "${KAYRA_ROOT}/test/lab/swarm-platform/complete-fixture" "$admission_repo"
            APP_NAME="$admission_app" yq -i '.name = strenv(APP_NAME) |
                .routes[0].host = strenv(APP_NAME) | .rollout.migrations = []' "${admission_repo}/app.yml"
            ADMISSION_MEMORY="$memory" yq -i '.services.web.deploy.resources.limits.memory = strenv(ADMISSION_MEMORY)' "${admission_repo}/deploy/compose.yml"
            jq --arg image "${admission_app}/web" '.image = $image' "${admission_repo}/web/docker/image.json" > "${work}/admission-image.json"
            mv "${work}/admission-image.json" "${admission_repo}/web/docker/image.json"
            git -C "$admission_repo" init -q -b main
            git -C "$admission_repo" add -A
            git -C "$admission_repo" -c user.name="Kayra lab" -c user.email=lab@kayra.test -c commit.gpgsign=false commit -qm "declared admission contender"
            admission_commit="$(git -C "$admission_repo" rev-parse HEAD)"
            git clone -q --bare "$admission_repo" "${served}/lab/${admission_app}.git"
            git -C "$admission_repo" bundle create "/tmp/kayra-swarm-platform-${vm_name}.${admission_app}.bundle" --all
            admission_request="$(python3 -c 'import uuid; print(uuid.uuid4())')"
            jq --arg app "$admission_app" --arg commit "$admission_commit" --arg request "$admission_request" \
                --arg repo "http://${host_ip}:${port}/lab/${admission_app}.git" \
                '.admission_applications += [{app:$app,commit:$commit,request:$request,repo:$repo}]' \
                "$inputs" > "$inputs.next"
            mv "$inputs.next" "$inputs"
        done
    }
    step "7  indexed registration through Ansible and the running deployer"
    ANSIBLE_CONFIG="${KAYRA_ROOT}/ansible/ansible.cfg" ansible-playbook         -i "servers/${server}/inventory.ini"         "${KAYRA_ROOT}/test/lab/registration-generation/live.yml"         -e "kayra_root=${KAYRA_ROOT}" -e "kayra_lab_swarm=${swarm_host}" >> "$log" 2>&1 || die "indexed registration through Ansible"
    echo "✓ indexed registration survived a deployer restart and protected its app name"
    indexed_repo="${work}/indexed-build"
    cp -R "${KAYRA_ROOT}/test/lab/app" "$indexed_repo"
    yq -i '.name = "indexed-build" | .routes[0].host = "indexed"' "${indexed_repo}/app.yml"
    jq '.image = "indexed-build/web"' "${indexed_repo}/web/docker/image.json" > "${work}/indexed-image.json"
    mv "${work}/indexed-image.json" "${indexed_repo}/web/docker/image.json"
    git -C "$indexed_repo" init -q -b main
    git -C "$indexed_repo" add -A
    git -C "$indexed_repo" -c user.name="Kayra lab" -c user.email=lab@kayra.test -c commit.gpgsign=false commit -qm "indexed build fixture"
    git clone -q --bare "$indexed_repo" "${served}/lab/indexed.git"
    indexed_commit="$(git -C "$indexed_repo" rev-parse HEAD)"
    ANSIBLE_CONFIG="${KAYRA_ROOT}/ansible/ansible.cfg" ansible-playbook \
        -i "servers/${server}/inventory.ini" \
        "${KAYRA_ROOT}/test/lab/registration-generation/build-live.yml" \
        -e "kayra_root=${KAYRA_ROOT}" \
        -e "fixture_repo=http://${host_ip}:${port}/lab/indexed.git" \
        -e "fixture_commit=${indexed_commit}" -e "kayra_lab_swarm=${swarm_host}" >> "$log" 2>&1 || die "building the indexed fixture"
    echo "✓ indexed build returned digest-qualified images and refused destructive GC"
    if [ "$swarm_host" = true ]; then
        swarm_repo="${work}/swarm-build"
        git clone -q "$indexed_repo" "$swarm_repo"
        yq -i '.name = "swarm-build" | .routes[0].host = "swarm" | .routes[0].check = "/" |
            .rollout = {"strategy": "rolling", "mixed_version_compatible": true, "rollback_compatible": true,
                        "services": {"web": {"role": "http", "overlap": "allowed"}}}' "${swarm_repo}/app.yml"
        jq '.image = "swarm-build/web"' "${swarm_repo}/web/docker/image.json" > "${work}/swarm-image.json"
        mv "${work}/swarm-image.json" "${swarm_repo}/web/docker/image.json"
        yq -i 'del(.services.web.mem_limit) |
            .services.web.deploy.resources = {"limits": {"memory": "64m", "cpus": "0.1"}, "reservations": {"memory": "32m", "cpus": "0.05"}} |
            .services.web.healthcheck = {"test": ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/"], "interval": "1s", "timeout": "1s", "start_period": "1s", "retries": 3} |
            .services.web.stop_grace_period = "30s"' "${swarm_repo}/deploy/compose.yml"
        git -C "$swarm_repo" add -A
        git -C "$swarm_repo" -c user.name="Kayra lab" -c user.email=lab@kayra.test -c commit.gpgsign=false commit -qm "new Swarm application fixture"
        git clone -q --bare "$swarm_repo" "${served}/lab/swarm.git"
        swarm_commit="$(git -C "$swarm_repo" rev-parse HEAD)"
        jq -n --arg repo "http://${host_ip}:${port}/lab/swarm.git" --arg commit "$swarm_commit" '{
            fixture_app: "swarm-build", fixture_runtime: "swarm", fixture_hosts: ["swarm.lab.test"],
            fixture_grants: {memory_bytes: 268435456, cpu_millicores: 500, maintenance: false},
            fixture_repo: $repo, fixture_commit: $commit, kayra_lab_swarm: true
        }' > "${work}/swarm-registration-inputs.json"
        ANSIBLE_CONFIG="${KAYRA_ROOT}/ansible/ansible.cfg" ansible-playbook \
            -i "servers/${server}/inventory.ini" \
            "${KAYRA_ROOT}/test/lab/registration-generation/build-live.yml" \
            -e "kayra_root=${KAYRA_ROOT}" -e "@${work}/swarm-registration-inputs.json" >> "$log" 2>&1 || die "registering and building the new Swarm application"
        echo "✓ new Swarm registration retained its runtime, grants and build receipt across restart"
        ANSIBLE_CONFIG="${KAYRA_ROOT}/ansible/ansible.cfg" ansible-playbook \
            -i "servers/${server}/inventory.ini" \
            "${KAYRA_ROOT}/test/lab/swarm-platform/http-control.yml" \
            -e "fixture_app=swarm-build" -e "fixture_commit=${swarm_commit}" \
            -e "report_path=${work}/http-control.json" >> "$log" 2>&1 || die "experimental HTTP control and promotion"
        cp "${work}/http-control.json" "/tmp/kayra-swarm-platform-${vm_name}.control.json"
        echo "✓ the real deployer promoted the retained Swarm plan with routed TLS readiness"

        complete_repo="${work}/rollout-complete"
        cp -R "${KAYRA_ROOT}/test/lab/swarm-platform/complete-fixture" "$complete_repo"
        git -C "$complete_repo" init -q -b main
        git -C "$complete_repo" add -A
        git -C "$complete_repo" -c user.name="Kayra lab" -c user.email=lab@kayra.test -c commit.gpgsign=false commit -qm "complete rollout A"
        complete_a="$(git -C "$complete_repo" rev-parse HEAD)"
        yq -i '.services.web.environment.RELEASE = "B" |
            .services.web.environment.FAIL_AFTER_EFFECT = "true" |
            .services.web.environment.MIGRATION_HOLD_MS = "30000"' "${complete_repo}/deploy/compose.yml"
        git -C "$complete_repo" add -A
        git -C "$complete_repo" -c user.name="Kayra lab" -c user.email=lab@kayra.test -c commit.gpgsign=false commit -qm "complete rollout B with app-provided recovery"
        complete_b="$(git -C "$complete_repo" rev-parse HEAD)"
        printf '\nVOLUME ["/unsafe-lab-volume"]\n' >> "${complete_repo}/web/Dockerfile"
        git -C "$complete_repo" add -A
        git -C "$complete_repo" -c user.name="Kayra lab" -c user.email=lab@kayra.test -c commit.gpgsign=false commit -qm "refuse inherited image volume before workload creation"
        complete_c="$(git -C "$complete_repo" rev-parse HEAD)"
        git -C "$complete_repo" checkout -q "$complete_b" -- web/Dockerfile
        yq -i '.rollout.migrations = []' "${complete_repo}/app.yml"
        yq -i '.services.web.environment.RELEASE = "OOM" |
            .services.web.environment.OOM_BYTES = "536870912"' "${complete_repo}/deploy/compose.yml"
        git -C "$complete_repo" add -A
        git -C "$complete_repo" -c user.name="Kayra lab" -c user.email=lab@kayra.test -c commit.gpgsign=false commit -qm "candidate exceeds its container memory budget after routed readiness"
        complete_oom="$(git -C "$complete_repo" rev-parse HEAD)"
        yq -i '.services.web.environment.RELEASE = "ENOSPC" |
            .services.web.environment.OOM_BYTES = "0"' "${complete_repo}/deploy/compose.yml"
        git -C "$complete_repo" add -A
        git -C "$complete_repo" -c user.name="Kayra lab" -c user.email=lab@kayra.test -c commit.gpgsign=false commit -qm "resume accepted rollout after bounded lifecycle ENOSPC"
        complete_enospc="$(git -C "$complete_repo" rev-parse HEAD)"
        git clone -q --bare "$complete_repo" "${served}/lab/complete.git"
        git -C "$complete_repo" bundle create "/tmp/kayra-swarm-platform-${vm_name}.complete-fixture.bundle" --all
        complete_requests="$(python3 -c 'import json,uuid; print(json.dumps({"A":str(uuid.uuid4()),"B":str(uuid.uuid4())}))')"
        jq -n --arg repo "http://${host_ip}:${port}/lab/complete.git" --arg a "$complete_a" --arg b "$complete_b" --argjson requests "$complete_requests" '{
            fixture_app: "rollout-complete", fixture_runtime: "swarm", fixture_hosts: ["complete.lab.test"],
            fixture_grants: {memory_bytes: 268435456, cpu_millicores: 500, maintenance: false},
            fixture_configuration: {MODE: "lab", DB_HOST: "kayra-complete-ledger"}, fixture_ledger: "kayra-complete-ledger",
            fixture_repo: $repo, fixture_commit: $a, fixture_commits: {A: $a, B: $b}, fixture_requests: $requests, kayra_lab_swarm: true
        }' > "${work}/complete-registration-inputs.json"
        ANSIBLE_CONFIG="${KAYRA_ROOT}/ansible/ansible.cfg" ansible-playbook \
            -i "servers/${server}/inventory.ini" \
            "${KAYRA_ROOT}/test/lab/swarm-platform/complete-control.yml" \
            -e "kayra_root=${KAYRA_ROOT}" -e "@${work}/complete-registration-inputs.json" \
            -e "report_path=${work}/complete-control.json" >> "$log" 2>&1 || die "integrated migration, restart recovery and HTTP promotion"
        cp "${work}/complete-control.json" "/tmp/kayra-swarm-platform-${vm_name}.complete.json"
        cp "${work}/complete-control.json.tar" "/tmp/kayra-swarm-platform-${vm_name}.complete.tar"
        cp "${work}/complete-control.json.source.json" "/tmp/kayra-swarm-platform-${vm_name}.complete.source.json"
        cp "${work}/complete-control.json.clock.json" "/tmp/kayra-swarm-platform-${vm_name}.complete.clock.json"
        echo "✓ real builds, app-owned migration recovery and routed HTTP survived coordinator interruption"

        image_request="$(python3 -c 'import uuid; print(uuid.uuid4())')"
        ANSIBLE_CONFIG="${KAYRA_ROOT}/ansible/ansible.cfg" ansible-playbook \
            -i "servers/${server}/inventory.ini" \
            "${KAYRA_ROOT}/test/lab/swarm-platform/image-admission.yml" \
            -e "kayra_root=${KAYRA_ROOT}" -e fixture_app=rollout-complete \
            -e "fixture_commit=${complete_c}" -e "fixture_request=${image_request}" \
            -e "report_path=${work}/image-admission.json" >> "$log" 2>&1 || die "refusing inherited image volumes before workload creation"
        cp "${work}/image-admission.json" "/tmp/kayra-swarm-platform-${vm_name}.image-admission.json"
        cp "${work}/image-admission.json.tar" "/tmp/kayra-swarm-platform-${vm_name}.image-admission.tar"
        cp "${work}/image-admission.json.source.json" "/tmp/kayra-swarm-platform-${vm_name}.image-admission.source.json"
        echo "✓ inherited image volume refused without accepting a rollout or creating app containers/volumes"

        oom_request="$(python3 -c 'import uuid; print(uuid.uuid4())')"
        oom_outcome=0
        ANSIBLE_CONFIG="${KAYRA_ROOT}/ansible/ansible.cfg" ansible-playbook \
            -i "servers/${server}/inventory.ini" \
            "${KAYRA_ROOT}/test/lab/swarm-platform/candidate-oom.yml" \
            -e "kayra_root=${KAYRA_ROOT}" -e fixture_app=rollout-complete \
            -e "fixture_commit=${complete_oom}" -e "fixture_request=${oom_request}" \
            -e "report_path=${work}/candidate-oom.json" >> "$log" 2>&1 || oom_outcome=$?
        for suffix in json json.source.json json.clock.json; do
            if [ -f "${work}/candidate-oom.${suffix}" ]; then
                install -m 600 "${work}/candidate-oom.${suffix}" "/tmp/kayra-swarm-platform-${vm_name}.candidate-oom.${suffix}"
            fi
        done
        if [ -f "${work}/candidate-oom.json.tar" ]; then
            install -m 600 "${work}/candidate-oom.json.tar" "/tmp/kayra-swarm-platform-${vm_name}.candidate-oom.tar"
        fi
        if [ "$oom_outcome" -eq 0 ]; then
            echo "✓ container OOM recovered the previous release without promoting the failed candidate"
        elif [ -f "${work}/candidate-oom.json" ] &&
            jq -e '.passed == false and .recovered.operation.recovery == "automatic-rollback" and
                (.achievedRequestsPerSecond < 19 or .maxRequestStartGapMs > 250)' "${work}/candidate-oom.json" >/dev/null; then
            oom_timing_invalid=true
            echo "! candidate OOM restored the previous release, but its request timing failed measurement thresholds"
        else
            die "candidate memory exhaustion and automatic recovery"
        fi

        prepare_admission_inputs "" "${work}/admission-inputs.json" 1024m 1073741824
        ANSIBLE_CONFIG="${KAYRA_ROOT}/ansible/ansible.cfg" ansible-playbook \
            -i "servers/${server}/inventory.ini" \
            "${KAYRA_ROOT}/test/lab/swarm-platform/admission-race.yml" \
            -e "kayra_root=${KAYRA_ROOT}" -e "@${work}/admission-inputs.json" \
            -e "report_path=${work}/admission-race.json" >> "$log" 2>&1 || die "concurrent admission and restart recovery"
        cp "${work}/admission-race.json" "/tmp/kayra-swarm-platform-${vm_name}.admission-race.json"
        cp "${work}/admission-race.json.tar" "/tmp/kayra-swarm-platform-${vm_name}.admission-race.tar"
        cp "${work}/admission-race.json.source.json" "/tmp/kayra-swarm-platform-${vm_name}.admission-race.source.json"
        cp "${work}/admission-race.json.clock.json" "/tmp/kayra-swarm-platform-${vm_name}.admission-race.clock.json"
        echo "✓ concurrent admission survived restart without overcommit or extending the waiter's deadline"

        enospc_request="$(python3 -c 'import uuid; print(uuid.uuid4())')"
        ANSIBLE_CONFIG="${KAYRA_ROOT}/ansible/ansible.cfg" ansible-playbook \
            -i "servers/${server}/inventory.ini" \
            "${KAYRA_ROOT}/test/lab/swarm-platform/lifecycle-enospc.yml" \
            -e "kayra_root=${KAYRA_ROOT}" -e fixture_app=rollout-complete \
            -e "fixture_commit=${complete_enospc}" -e "fixture_request=${enospc_request}" \
            -e "report_path=${work}/lifecycle-enospc.json" >> "$log" 2>&1 || die "bounded lifecycle ENOSPC and restart recovery"
        cp "${work}/lifecycle-enospc.json" "/tmp/kayra-swarm-platform-${vm_name}.lifecycle-enospc.json"
        cp "${work}/lifecycle-enospc.json.tar" "/tmp/kayra-swarm-platform-${vm_name}.lifecycle-enospc.tar"
        cp "${work}/lifecycle-enospc.json.source.json" "/tmp/kayra-swarm-platform-${vm_name}.lifecycle-enospc.source.json"
        cp "${work}/lifecycle-enospc.json.clock.json" "/tmp/kayra-swarm-platform-${vm_name}.lifecycle-enospc.clock.json"
        echo "✓ accepted rollout survived bounded lifecycle ENOSPC without replacing its identity or deadline"

        ANSIBLE_CONFIG="${KAYRA_ROOT}/ansible/ansible.cfg" ansible-playbook \
            -i "servers/${server}/inventory.ini" \
            "${KAYRA_ROOT}/test/lab/swarm-platform/health-observation.yml" \
            -e "kayra_root=${KAYRA_ROOT}" \
            -e "report_path=${work}/runtime-health.json" >> "$log" 2>&1 || die "current runtime and platform health observations"
        cp "${work}/runtime-health.json" "/tmp/kayra-swarm-platform-${vm_name}.runtime-health.json"
        cp "${work}/runtime-health.json.source.json" "/tmp/kayra-swarm-platform-${vm_name}.runtime-health.source.json"
        echo "✓ runtime health ignores historical tasks without changing the certified release"

    fi
    if [ "$managed_rollouts" = true ]; then
        step "8  opted-in managed rollout with the real builder, migration probe and routed traffic"
        managed_repo="${work}/managed-complete"
        cp -R "${KAYRA_ROOT}/test/lab/swarm-platform/complete-fixture" "$managed_repo"
        yq -i '.name = "managed-complete" | .routes[0].host = "managed-complete"' "${managed_repo}/app.yml"
        jq '.image = "managed-complete/web"' "${managed_repo}/web/docker/image.json" > "${work}/managed-image.json"
        mv "${work}/managed-image.json" "${managed_repo}/web/docker/image.json"
        git -C "$managed_repo" init -q -b main
        git -C "$managed_repo" add -A
        git -C "$managed_repo" -c user.name="Kayra lab" -c user.email=lab@kayra.test -c commit.gpgsign=false commit -qm "managed rollout A"
        managed_a="$(git -C "$managed_repo" rev-parse HEAD)"
        yq -i '.services.web.environment.RELEASE = "B" |
            .services.web.environment.FAIL_AFTER_EFFECT = "true" |
            .services.web.environment.MIGRATION_HOLD_MS = "30000"' "${managed_repo}/deploy/compose.yml"
        git -C "$managed_repo" add -A
        git -C "$managed_repo" -c user.name="Kayra lab" -c user.email=lab@kayra.test -c commit.gpgsign=false commit -qm "managed rollout B with app-provided recovery"
        managed_b="$(git -C "$managed_repo" rev-parse HEAD)"
        yq -i 'del(.rollout.migrations)' "${managed_repo}/app.yml"
        managed_add_http_release() {
            local release="$1" delay="$2" never="$3" crash="$4" memory="$5"
            RELEASE="$release" READY_DELAY="$delay" NEVER_READY="$never" CRASH_DELAY="$crash" OOM_BYTES="$memory" yq -i '
                .services.web.environment.RELEASE = strenv(RELEASE) |
                .services.web.environment.READY_DELAY_MS = strenv(READY_DELAY) |
                .services.web.environment.NEVER_READY = strenv(NEVER_READY) |
                .services.web.environment.FAIL_AFTER_READY_MS = strenv(CRASH_DELAY) |
                .services.web.environment.OOM_BYTES = strenv(OOM_BYTES) |
                del(.services.web.environment.FAIL_AFTER_EFFECT, .services.web.environment.MIGRATION_HOLD_MS)
            ' "${managed_repo}/deploy/compose.yml"
            git -C "$managed_repo" add -A
            git -C "$managed_repo" -c user.name="Kayra lab" -c user.email=lab@kayra.test -c commit.gpgsign=false commit -qm "managed HTTP rollout $release"
            git -C "$managed_repo" rev-parse HEAD
        }
        managed_c="$(managed_add_http_release C 15000 false 0 0)"
        managed_d="$(managed_add_http_release D 0 true 0 0)"
        managed_e="$(managed_add_http_release E 0 false 8000 0)"
        managed_f="$(managed_add_http_release F 0 false 0 0)"
        managed_g="$(managed_add_http_release G 0 false 0 268435456)"
        managed_enospc="$(managed_add_http_release ENOSPC 0 false 0 0)"
        git clone -q --bare "$managed_repo" "${served}/lab/managed.git"
        managed_requests="$(python3 -c 'import json,uuid; print(json.dumps({key:str(uuid.uuid4()) for key in "ABCDEFG"}))')"
        jq -n --arg repo "http://${host_ip}:${port}/lab/managed.git" --arg a "$managed_a" --arg b "$managed_b" \
            --arg c "$managed_c" --arg d "$managed_d" --arg e "$managed_e" --arg f "$managed_f" --arg g "$managed_g" --argjson requests "$managed_requests" '{
            fixture_app: "managed-complete", fixture_runtime: "swarm", fixture_hosts: ["managed-complete.lab.test"],
            fixture_grants: {memory_bytes: 536870912, cpu_millicores: 1000, maintenance: false},
            fixture_configuration: {MODE: "lab", DB_HOST: "kayra-managed-ledger"}, fixture_ledger: "kayra-managed-ledger",
            fixture_repo: $repo, fixture_commit: $a, fixture_commits: {A: $a, B: $b, C: $c, D: $d, E: $e, F: $f, G: $g}, fixture_requests: $requests,
            kayra_lab_swarm: true, kayra_lab_managed_rollouts: true
        }' > "${work}/managed-registration-inputs.json"
        ANSIBLE_CONFIG="${KAYRA_ROOT}/ansible/ansible.cfg" ansible-playbook \
            -i "servers/${server}/inventory.ini" \
            "${KAYRA_ROOT}/test/lab/swarm-platform/complete-control.yml" \
            -e "kayra_root=${KAYRA_ROOT}" -e "@${work}/managed-registration-inputs.json" \
            -e "report_path=${work}/managed-control.json" >> "$log" 2>&1 || die "managed builder, migration, restart and routed HTTP"
        for evidence in "" .tar .source.json .clock.json; do
            install -m 600 "${work}/managed-control.json${evidence}" "/tmp/kayra-swarm-platform-${vm_name}.managed-control.json${evidence}"
        done
        echo "✓ opted-in managed rollouts verified after real coordinator interruption"
        step "8a  bounded metadata exhaustion and restart under managed control"
        managed_enospc_request="$(python3 -c 'import uuid; print(uuid.uuid4())')"
        ANSIBLE_CONFIG="${KAYRA_ROOT}/ansible/ansible.cfg" ansible-playbook \
            -i "servers/${server}/inventory.ini" \
            "${KAYRA_ROOT}/test/lab/swarm-platform/lifecycle-enospc.yml" \
            -e "kayra_root=${KAYRA_ROOT}" -e fixture_app=managed-complete \
            -e "fixture_commit=${managed_enospc}" -e "fixture_request=${managed_enospc_request}" \
            -e "report_path=${work}/managed-enospc.json" >> "$log" 2>&1 || die "managed bounded metadata exhaustion"
        for evidence in "" .tar .source.json .clock.json; do
            install -m 600 "${work}/managed-enospc.json${evidence}" "/tmp/kayra-swarm-platform-${vm_name}.managed-enospc.json${evidence}"
        done
        step "8b  competing managed resource reservations across restart"
        # Stage 7 left one 1 GiB contender and two smaller apps certified.
        # With the managed baseline settled, exactly one 600 MiB contender fits.
        prepare_admission_inputs managed- "${work}/managed-admission-inputs.json" 600m 629145600
        ANSIBLE_CONFIG="${KAYRA_ROOT}/ansible/ansible.cfg" ansible-playbook \
            -i "servers/${server}/inventory.ini" \
            "${KAYRA_ROOT}/test/lab/swarm-platform/admission-race.yml" \
            -e "kayra_root=${KAYRA_ROOT}" -e "@${work}/managed-admission-inputs.json" \
            -e "report_path=${work}/managed-admission.json" >> "$log" 2>&1 || die "managed concurrent admission and restart"
        for evidence in "" .tar .source.json .clock.json; do
            install -m 600 "${work}/managed-admission.json${evidence}" "/tmp/kayra-swarm-platform-${vm_name}.managed-admission.json${evidence}"
        done
    fi
    kayra_cmd verify "$server" || die "platform verification after indexed registration"
fi

[ "$oom_timing_invalid" = false ] || die "candidate OOM timing needs a repeat; subsequent results are retained"
passed=true
step "the upgrade from ${from} holds"
