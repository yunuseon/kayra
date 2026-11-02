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
