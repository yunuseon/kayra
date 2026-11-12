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
its temporary storage are lab fixtures. The opt-in upgrade scenario below
exercises live Ansible registration; ordinary fleet registration remains legacy.

The indexed fixture also stages the full initial request in root-only storage
before ticket allocation. After each kill it reopens that storage to recover
the original generation ID. The platform storage suite verifies that a lost
staging acknowledgement recovers the same request and that changing the
payload under the same app is refused.

After verifying publication, the platform writes a root-owned evidence record
that contains only the operation identity and applied status. The coordinator
reads that record using the platform adapter. The fixture exercises this
handoff through ordinary files. The upgrade scenario mounts evidence read-only
and fences legacy writers; production enablement remains excluded.

The fixture invokes the same root-side command intended for the platform
caller. It sends bounded JSON on stdin for staging, publication and
verification. The command rejects symlinked or writable ancestors of its
storage root and accepts publication identities from the trusted caller that
holds the registration fence. The fixture creates its root under `/var/lib`
to exercise that path validation.

The fixture uses the deployer's localhost HTTP handler and `ctl registration`
to reserve, submit and reconcile. It binds port 8091 inside the isolated guest
and permits only the fixture app. Default startup supplies no registration
handler. The explicit upgrade-lab override enables it in the existing deployer
process and mounts the coordinator name claims read-only.

The host command also exposes `register`, which stages the request and calls
the deployer's existing Compose exec control path to reserve, submit and
reconcile it. A retry uses the same staged payload and accepts already-verified
publication without replacing the generation. The storage suite covers a
retry after publication with a pending receipt.

The fixture also reads the public registration and then uses its exact
generation identity to read private configuration and secrets. A mismatched
private manifest is refused. Public consumers require only the public tree.

The final indexed case starts the real deployer daemon with an explicit
evidence directory. It verifies that the default startup leaves registration
disabled, that an opted-in daemon requires explicit initialization, and that
a restarted daemon reopens the existing index and returns the verified receipt.

Run the Ansible and container integration with the upgrade lab:

```bash
bash test/lab/upgrade.sh --indexed-registration --vm-name kayra-indexed-lab-unique
```

It upgrades the regular platform first, enables registration in an explicit
lab override, registers a synthetic app through Ansible, restarts the deployer
and requires the same durable receipt. It also checks legacy purge refusal
and runs platform verification after the experiment.

The indexed upgrade scenario builds a second fixture from its real Git
repository. Its artifact tags use the full input commit and the builder
returns manifest digests. The deployer validates the bundle's registration
identity and digest references. The lab also verifies that legacy registry GC
refuses cleanup while coordinator-managed app claims exist.

The same scenario invokes `kayra-deployer ctl build indexed-build <full-commit>`.
The coordinator records verified registration identity, full commit and an
absolute 45-minute build deadline before calling the builder. It retains only
validated bundle fields in content-addressed, synchronized files, then records
the receipt. The lab stops the builder, restarts the deployer, and requires the
same receipt. Missing or corrupted retained content fails closed. Interrupted
preparations can be retried at the same commit and original deadline; these
operations build images only and do not authorize workload deployment or mark
an active release. Files under `lifecycle/artifacts` are private coordinator
storage, not a platform read interface.

`kayra-deployer ctl pins` publishes registration identity, commit, artifact hash
and image digests for retained builds, plus unresolved build identities and
deadlines. It verifies retained content and ownership before reporting pins;
missing artifacts cause refusal. The projection is explicitly incomplete until
active, candidate and rollback runtime plans are integrated. It contains no
Compose content, resolved configuration or secret values, and does not enable
registry GC.

Indexed artifacts may carry an app's validated `rollout` section. The builder
validates its shape before building, and the coordinator validates it again
before retention. Ordinary legacy requests still refuse any rollout declaration.
Artifact retention grants no runtime capability and does not enable rollout
execution.

With `--swarm-host`, the upgrade scenario also registers a new `swarm-build`
fixture with explicit resource and maintenance grants. Registration checks the
current root-owned host authority and live Docker identities before claiming
its name. Runtime selection is journaled with the generation before publication;
`ctl registration policy <app>` reports it only after verification. The scenario
builds and retains its rollout-bearing artifact and recovers the same receipt
while the builder is stopped. It does not start this app's workloads. Ordinary
fleet registration remains Compose-only until adapter/admission integration.

`ctl preview <app> <full-commit>` reads an already-retained Swarm artifact and
returns `{admitted:false, plan:...}`. It performs no build or workload mutation.
The normalized proposal pins registration, artifact, image digests, platform
authority, grants and configuration identity. Environment values remain literal
app data or exact configuration/secret references. The lab previews while the
builder is stopped and the fixture secret is hidden, then restores the secret.
Host admission must still account for active workloads and candidate overlap.

The first HTTP normalizer accepts one Compose file up to 256 KiB, one rolling
HTTP service and one route. It supports explicit CPU/memory limits and
reservations, CMD health checks with whole-second timings, argument-list command
and entrypoint overrides, declared environment references, and the implicit app
network. It refuses unknown fields, file inclusions/extends, env files, implicit
host environment, mounts, published ports, custom networks, application routing
labels and unsupported roles/strategies. It parses without resolving variables,
reading host paths or invoking Docker. Multi-service/dependency/worker and
maintenance semantics remain subsequent integration work; legacy Compose
normalization is unchanged.

The Linux interruption suite also checks the independent initial-registration
receipt before and after restart. The unit recovery suite advances more than
128 subsequent terminal tickets and reopens the app index: registration policy
and historical registration retries must remain available after ticket eviction.
A missing certificate after eviction requires intervention.

The HTTP journal tests bind a request, ticket and lifecycle fence atomically,
retain its normalized plan, and acquire host-wide capacity at the original
90-second deadline before recording a native service/version intent. They cover
lost acknowledgements, plan corruption, expired admission and SIGKILL after the
native intent is durable. Recovery returns `reconcile` and cannot refresh the
Docker version. These tests do not dispatch a native write or promote a release;
those paths remain subsequent integration work.
