# Registration-generation filesystem experiment

This Linux-only fixture tests publishing separate public and private generation
directories followed by an atomic public pointer. It is disconnected from Kayra's
platform, queue and lifecycle journal. CI runs it only in temporary directories.

The tests cover exclusive generation creation, permissions, synthetic-secret
visibility, symlink refusal, partial I/O failure, process kills around publication
and a pointer rename whose acknowledgement is lost. A potentially published
generation is preserved on uncertainty. Seeing a pointer after a process kill
does not establish power-loss durability or complete runtime recovery.

The caller supplies a trusted directory descriptor and controls its ancestors.
No untrusted writer may replace entries there. The fixture accepts trusted public
and private input; it does not classify secrets or implement Kayra's registration
metadata, group permissions, volume ownership, concurrent app fencing or an
authoritative observer. Owner-writable files are not immutable against their
owner. It must not be installed as the production publisher.

## Run in an isolated Ubuntu VM

From the repository root, choose a new name. Refuse an existing name rather than
reusing or deleting someone else's VM. These commands use no Docker context:

```bash
set -euo pipefail
lab_vm="kayra-registration-lab-$(date -u +%Y%m%d%H%M%S)"
multipass launch 24.04 --name "$lab_vm" --cpus 2 --memory 1G --disk 8G
multipass exec "$lab_vm" -- cloud-init status --wait
multipass exec "$lab_vm" -- mkdir /home/ubuntu/registration-lab
multipass transfer test/lab/registration-generation/publisher.py test/lab/registration-generation/test_publisher.py "$lab_vm":/home/ubuntu/registration-lab/
multipass exec "$lab_vm" -- sudo python3 -B /home/ubuntu/registration-lab/test_publisher.py
```

Keep a failed VM and its output for inspection. After a successful run, remove
only that VM unless retaining it deliberately:

```bash
multipass delete --purge "$lab_vm"
```

Capture `multipass version`, `multipass info "$lab_vm" --format json`, guest
Python/kernel/OS versions and source SHA-256 hashes when recording a result.
The checked-in `results/2026-11-02/` evidence describes the resumed seven-case
run; it is filesystem evidence, not a full platform acceptance result.

## Experimental platform adapter

The root-side implementation under `scripts/server-lib/` has its own stricter
suite. It is packaged but remains uninstalled and unused by live host writers.
On a fresh Linux checkout run:

```bash
sudo python3 -B ci/tests/registration-generation/test_generation.py
```

The suite covers complete metadata and secret-key checks, private service-group
access, immutable-generation collisions, symlinks, hard links, nonregular files,
owner/mode failures, failed synchronization, lost rename acknowledgements,
publisher process kills and competing pointer updates. It refuses to pass by
skipping when Linux root is unavailable. The shared JSON fixture is also checked
against the TypeScript contracts. `results/2026-11-02-adapter/` records exact
sources and environment for the isolated Multipass run.

## Indexed registration recovery

Run from a Linux checkout with the locked npm dependencies installed, Node 24
and Python 3. The fixture requires root for the platform storage operations.

```bash
sudo "$(command -v node)" --test test/lab/registration-generation/indexed_flow.mjs
```

The fixture runs the coordinator's app index and the platform publisher with
synthetic inputs. It kills the coordinator after allocating a ticket without
delivering the reply, after intent, after publication, and after the observer
verifies publication but before its result reaches the journal. A retry with
the same generation ID recovers the original ticket. On restart, it uses the same app index and real platform observation.
Unpublished operations stay pending. The two published operations settle
without publishing again, and a second restart returns the durable receipt.

CI runs these cases as `platform:indexed-registration`. The Python bridge and
its temporary storage are lab fixtures. Live Ansible registration and its
coordination with deploy, remove and purge still require integration tests.

The indexed fixture also stages the full initial request in root-only storage
before ticket allocation. After each kill it reopens that storage to recover
the original generation ID. The platform storage suite verifies that a lost
staging acknowledgement recovers the same request and that changing the
payload under the same app is refused.

After verifying publication, the platform writes a root-owned evidence record
that contains only the operation identity and applied status. The coordinator
reads that record using the platform adapter. The fixture exercises this
handoff through ordinary files. Production integration still needs to mount the
evidence directory read-only in the deployer and keep publication fenced.

The fixture invokes the same root-side command intended for the platform
caller. It sends bounded JSON on stdin for staging, publication and
verification. The command rejects symlinked or writable ancestors of its
storage root and accepts publication identities from the trusted caller that
holds the registration fence. The fixture creates its root under `/var/lib`
to exercise that path validation.

The fixture uses the deployer's localhost HTTP handler and `ctl registration`
to reserve, submit and reconcile. It binds port 8091 inside the isolated guest
and permits only the fixture app. Production startup supplies no registration
handler yet. The app role and legacy lifecycle commands still need a shared
fence before this path can be enabled on a platform host.
