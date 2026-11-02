# Experimental platform registration storage

`registration_generation.py` is a Linux root-side storage adapter. It is packaged
with the engine but **not installed or invoked by the platform role**. No current
Ansible, builder, deployer, restore, removal or purge path uses it.

The trusted platform caller supplies an open root directory descriptor, the
metadata validated by `cli/src/contracts/registration-generation.ts`, a Compose
registration, configuration strings, declared secret strings and the provisioned
deployer group ID. Inputs stay in process memory; no command-line secret or
resolved-secret journal format is added. Configuration is stored as JSON to avoid
environment-file interpolation. A shared fixture checks the Python and TypeScript
formats. The adapter currently accepts Compose registrations only.
Its additional refusal rules include repository credentials, duplicate or
oversized keys, and configuration keys that overlap declared secrets. Future
admission must surface these restrictions before starting a platform operation;
the existing Compose registration path is not converted by this change.

The root and its ancestry must be root-controlled, with no untrusted path writer.
The caller must durably provision the root and synchronize its parent before
using the adapter; syncing the supplied descriptor cannot seal its own parent.
The existing deploy-owned platform directory is not sufficient for that trust
boundary. The durable lifecycle owner must establish the app/incarnation from an
authoritative index and hold its app fence throughout publication or observation.
Missing storage is not evidence of a new app. A local per-app `flock` orders this
adapter's calls but cannot stop older scripts or privileged bypasses.

Layout under the supplied root:

```text
public/<sha256-app>/current.json
public/<sha256-app>/generations/<generation>/manifest.json
public/<sha256-app>/generations/<generation>/registration.json
private/<sha256-app>/generations/<generation>/manifest.json
private/<sha256-app>/generations/<generation>/configuration.json
private/<sha256-app>/generations/<generation>/secrets/<KEY>
```

Generation directories are exclusively created and are never overwritten or
deleted here. Public files are root-owned `0444`; private files are root-owned
`0440` with the supplied group. Final generation directories are `0555` and
`0550` respectively. Reads verify regular files, modes, owner, group, link count,
declared keys, bounded size and matching identities. Directory traversal uses
open directory descriptors and refuses symlinks. These permissions protect
against service users, not a root writer.

`publish` requires an exact prior pointer and an advancing action in the same
incarnation, synchronizes generation files/directories, then atomically replaces
and synchronizes the pointer. On any uncertain outcome it preserves data. A
partial or colliding generation requires reconciliation; retrying publication is
not the recovery mechanism. Limits are 128 keys, 128 characters per key, 64 KiB
per file and 1 MiB aggregate configuration/registration/secret content.

`observe` opens only existing storage and checks both trees. It synchronizes
files and directories before returning identity-bound `applied` evidence for the
coordinator. `not-applied` describes a missing or different current pointer only;
it does not assert that partial effects are absent. Invalid, unavailable or
incomplete evidence returns `unknown`. No secret values or hashes are returned.
An observation must remain under the same app gate until journal settlement.

The library provides no authenticated frontend, request deadlines, generation
garbage collection, migration safety, durable app-index allocation or live queue
fencing. Callers must retain unresolved intent when filesystem I/O blocks or a
process disappears. Activating this adapter before all writers participate would
leave registration/removal/purge races open.

Tests: `sudo python3 -B ci/tests/registration-generation/test_generation.py` on
Linux. They operate only under new temporary directories, including tests that
drop privileges and kill child publishers. They do not prove power-loss
durability or the final production container mounts.
