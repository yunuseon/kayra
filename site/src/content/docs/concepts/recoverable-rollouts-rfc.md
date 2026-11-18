---
title: 'RFC: boundaries and recoverable application rollouts'
description: Proposed server boundaries and an experimental, app-declared rollout contract.
---

**Status: proposed.** This RFC is the specification for a sequence of changes,
not a description of functionality available today. In particular, the current
Compose deployer does not provide the journal, recovery, admission or Swarm
semantics described here. Existing apps keep their current behavior while those
changes are delivered. No production host is automatically converted.

## Decision and scope

Kayra remains one package, pinned by the fleet and released as a unit. The fleet
selects a runtime for each registration; the application declares the behavior
and capabilities it needs. Compose remains the workload description, extended
with app-owned `rollout` metadata in `app.yml`, carried in the validated build bundle. The default runtime is Compose.
Swarm requires both explicit server enablement and an explicit new app
registration. Changing the runtime of an already managed app is rejected;
conversion is outside this integration.

Apps may declare a compatible rolling rollout or a disruptive maintenance
rollout. The latter also requires a fleet grant. The platform does not infer
schema compatibility, queue semantics or singleton leadership from an image.
It checks declarations against fleet grants and runtime capabilities before
mutation, without silently selecting a different backend.

## Ownership and trust

| Boundary | Owns | Excludes |
| --- | --- | --- |
| Operator core and clients | Fleet configuration, plans, approvals, presentation and requests to server components | Workload orchestration and private deployment files |
| Platform | Host provisioning, shared services, routing, TLS and auth policy, registration grants, secret materialization, infrastructure health and maintenance | Application release selection, rollout state machines and migration semantics |
| Builder | Commit resolution, image building and immutable build bundles | Host Docker access, application secrets and deployment decisions |
| Deployment coordinator | Application lifecycle, admission leases, sequencing, durable operation state, recovery and promotion | Host provisioning, forge-specific logic, raw Docker commands and app SQL or queue logic |
| Runtime adapters | Compose/Swarm rendering, operations on owned workloads and normalized observations | Fleet interpretation, rollout policy, notification and app-specific recovery |
| Shared contracts | Validated registration, bundle, deployment, observation and reporting formats | Effects or imports from implementations |
| Application | Readiness, compatibility, migrations, message delivery/idempotency and singleton coordination | Platform privileges and infrastructure selection |

The intended code layout is `cli/src/server/` for the server components and
`cli/src/contracts/` for dependency-light contracts. The coordinator's
policy uses typed ports; runtime-specific branches belong in adapters and
capability validation. Import rules and tests enforce those directions, and
coordinator logic cannot invoke a generic shell executor. Builder output crosses
an untrusted boundary and is validated again before admission. Platform
consumers call deployment commands and consume published read models instead of
reading a private journal. Lifecycle scripts are callers of the lifecycle
interface, not independent workload or record owners. Maintenance scheduling,
infrastructure health, notifications and forge integration are platform or
integration concerns rather than coordinator concerns.

This is a code boundary, not a new security boundary. The builder continues to
run in a separate process without the Docker socket, Docker CLI or app secrets.
Trusted server modules may be assembled by one explicit composition root in
the existing privileged deployer process. No second Docker-socket holder and no
new internal RPC service are introduced. The platform owns routing policy;
app-generated routing labels do not become authority over shared routing.

Trusted experimental registration/build/plan wiring now lives in
`cli/src/server/composition/registration.ts`. The legacy startup path is a thin
compatibility export, and registration control receives named typed ports rather
than positional optional capabilities. Composition remains inside the existing
privileged deployer; it creates no new daemon, socket holder or internal RPC.
Import rules reject dependencies from component logic back into composition,
from clients into server implementations, and from composition into fleet/client
policy. The MCP SDK's own server package remains a supported client dependency.

## Contracts and admission

A registration carries its selected runtime and grants. The managed app
persists that selection, and ordinary deployment cannot change it. Experimental
hosts and workloads declare finite CPU and memory budgets. Serialized
admission accounts for the active workloads, candidate overlap, one-shot jobs
and platform overhead; it reserves the budget before effects. A reservation is
not proof that Docker can schedule a task: actions also have finite deadlines.

The Compose-only compatibility path accepts an optional fleet entry
`runtime: compose` and records Compose on registration; older registrations
without a runtime remain valid. Older Kayra CLIs have a strict fleet schema and
reject that explicit key, so remove it before downgrading to such a version.
Leaving it out preserves the previous fleet-file format.

For an opted-in Swarm app, `rollout` declares:

- The `rolling` or `maintenance` strategy. Rolling explicitly asserts
  mixed-version and rollback compatibility.
- The role of every long-running service: HTTP, worker, singleton or retained
  dependency; its overlap is allowed, forbidden or coordinated by the app.
- Ordered migration steps, each naming an app-image service, an explicit
  bounded timeout and recovery behavior. The server sets the maximum timeout.
- Optional post-rollout checks executed in admitted app containers. A
  coordinated singleton handoff requires a completion check.

Compose supplies resource limits, health checks, shutdown settings,
dependencies and named volumes. The admitted description is normalized into
an immutable deployment plan: exact image digests, configuration identity,
secret-generation references, grants and owned volume identities. A resolved
secret value never belongs in a journal or published read model. Validation
rejects unsupported Compose features, dependency cycles, contradictory
settings, missing budgets and unsupported requirements rather than ignoring
them. Retained dependencies remain available to migrations, and their
specification cannot change after initial creation in this integration;
database-engine upgrades are a separate operation.

The plan and registration are validated at each trust boundary. An already
admitted plan is not reconstructed from a moving branch after a restart.
Shared contracts import no component implementation. The operator, builder,
platform, coordinator and adapters may depend on these contracts; the
coordinator calls ports rather than importing a concrete adapter. Adapters do
not import fleet policy or coordinator decision logic. The composition root is
the only place that chooses and wires concrete implementations. Contract
fixtures must exercise the operator, builder and coordinator boundaries
consistently. Field names and wire formats are implementation
contracts to be finalized together with their validators, not implied by this
RFC's prose.

## Rollout and recovery

For rolling HTTP services the Swarm adapter uses start-first replacement and
VIP discovery, health-gated convergence, a 30-second failure monitor and a
30-second shutdown grace. A worker whose overlap is forbidden is stop-first.
An app-coordinated singleton can start healthy on standby; the app owns the
leadership protocol and reports completion. A fleet-granted maintenance
rollout quiesces consumers, retains dependencies, runs migrations, starts
consumers and verifies the result. Its expected downtime is reported.

The coordinator promotes a release only after runtime convergence, routed
readiness and every required handoff check pass. A multi-service release is
coordinated reconciliation, not an atomic transaction. If a compatible rolling
release fails, the coordinator restores every changed service to the recorded
previous plan. A maintenance release may declare rollback unsafe: after an
irreversible or uncertain change, data is preserved and forward recovery is
required instead of automatically restoring old application images. Kayra does
not execute down-migrations or promise exactly-once delivery.

Migrations are individually identified, admitted one-shot app containers
with automatic restart disabled, a stable operation identity and retained
runtime evidence. After interruption the coordinator first observes an existing
container. It may retry a step declared replay-safe; otherwise it invokes the
app's declared status probe, which reports `applied`, `not-applied` or
`unknown`. An unknown or otherwise unresolved outcome blocks progress for an
audited operator decision identifying the run and step. A probe result is
interpreted according to the app's declared recovery contract, never as evidence
of application-specific SQL semantics. The recovery operation is published
through the ordinary operation catalog and all clients.

## Durable lifecycle

One coordinator holds an exclusive single-writer lock. A second writer is
refused. The filesystem journal uses atomic replacement and filesystem
synchronization; it records intent before effects, stable action identities and
absolute deadlines. Update and rollback deadlines default to 90 seconds and
survive restarts, as do migration deadlines and admission leases. Recovery
observes owned runtime objects and reconciles them with recorded intent rather
than assuming an interrupted command failed or granting a new timeout.

The lifecycle records these transitions, with each external effect bracketed
by persisted intent and observed completion:

```text
requested → validated → admitted → preparing → applying → verifying → active
                              ↘ failed → compensating → recovered
                                 ↘ blocked → operator resolution → reconciling
```

The diagram summarizes phases, not a promise that every app runs every step.
Recovery re-enters the recorded phase and inspects the effect associated with
its stable action identity; a blocked operation remains blocked until evidence
or an audited decision permits it to proceed. Removal has its own fenced →
settling → workloads removed → tombstoned path; purge requires a separate
request and ownership/attachment checks.

The state distinguishes requested and desired release, observed runtime,
verified active release, last known good release, rollback eligibility and any
required intervention. A successful operation's public projection reports its
phase, active release, recovery outcome and required action without exposing
secrets. Legacy Compose history remains readable, but its newest filename alone
is not proof of a verified active release, and new recovery guarantees do not
apply retroactively to interrupted legacy runs.

New indexed applications receive a durable data-owner UUID in the same initial
index write that reserves their application incarnation. The identifiers are
distinct: data ownership must later survive app removal and reincarnation.
Each physical local volume has a separate allocation UUID and an exact generated
name, with application/data-owner/key/allocation labels. A new allocation after
purge uses a new name; stale effects must not target a later allocation.
Ownership references are read-only metadata, not resource admission or workload
permission, and do not choose an application's runtime.

Older index rows remain readable without this field. They do not acquire data
ownership inferred from app incarnations, directories, Compose prefixes or
existing Docker objects. The first integration must explicitly refuse managed
data plans for such rows. Removing or purging records must retain the minimal
data-owner/allocation tombstone needed to prevent name reuse or unsafe adoption.
Runtime deletion requires exact local ownership plus stopped-container and both
current/previous service-spec attachment checks under the coordinator's
lifecycle fence. An unresolved creation or purge remains the owner's concern;
a runtime observation alone does not authorize deletion.

Removal first fences new deployments, then cancels or settles existing work and
removes owned workloads. It retains named volumes and a minimal ownership
tombstone. Purge is a separate guarded operation that checks ownership,
registration and live attachments; it never deletes unrelated data. Restore,
remove and purge go through the owning lifecycle component.

Legacy Compose remove and purge serialize per app. Removal records a
pending marker before unregistering. A failed stop leaves the marker in place
and purge refuses the app until removal completes. Fleet pruning includes
pending removals so it can retry after a crash.

Legacy Ansible registration holds the same lock through its configuration,
secret and registration writes. The deployer takes the lock before queue
admission and holds it through queued and running work for the app. This
serializes cooperating live writers. Interrupted Docker effects still require
durable reconciliation, and purge still requires verified volume ownership
and attachments for the new lifecycle path.

### Coordinator app index

The experimental coordinator index owns the link between an app name and its
operation journal. Provisioning creates a fresh index directory under a trusted
parent. Startup opens an existing index under an exclusive writer lock and
refuses missing state. The coordinator's composition root must select this
directory durably and control its ancestry. A fresh directory is never a
recovery procedure for a missing index.

The index records an initializing app and its server-assigned incarnation
before creating the app's directory. The directory name is the SHA-256 digest
of the validated app name. After syncing the directory entry and initializing
the envelope, the index marks the app ready. A retry can finish initialization
using the same incarnation. A ready entry with a missing or mismatched journal
requires intervention. Unindexed directories and envelopes that already issued
tickets during initialization also require intervention.

The index is wired to initial registration intent and receipt reconciliation
through the envelope store. Calls for the same app are serialized. An app's
observer does not hold up operations for other apps. Each observation attempt
has a ten-second deadline. On timeout the coordinator signals cancellation,
discards late evidence and leaves the registration pending for another attempt. The index does not adopt legacy apps or
assign a new incarnation to an existing name. Legacy entrypoints still bypass
this experimental path.

### Proposed per-app lifecycle protocol

The following protocol specifies the intended replacement for the current
Ansible and control paths; it is not implemented yet. The coordinator is the
single authority for app lifecycle transitions. It serializes admission and
queue starts with registration changes, restore, removal and purge for each app.
Different apps may proceed concurrently subject to host-wide admission and
maintenance constraints. A transition closes the app's in-memory gate before
any asynchronous journal write, persists its intent before acknowledging the
request or performing an effect, and fails closed if persistence fails. Each
operation has a stable identity and app generation; a stale completion cannot
advance a newer operation. A timeout or disconnected caller does not release a
gate while an effect might still be running.

For retryable host requests, the owner first durably allocates a sequence ticket
within the app incarnation; allocation alone has no workload effect. The client retains
that ticket and its request before submission. The allocator also needs a
durable, non-reusable client allocation identity or an audited way to recover
an allocation whose response was lost; otherwise unknown reservations exhaust
capacity. A bounded cache alone must not allow an old allocation key to be
reused after eviction. The owner binds the ticket to the
validated, non-secret request and records intent atomically. A retry of the same
ticket returns its existing progress or terminal receipt; a different request
under that ticket is refused. Unresolved tickets remain pinned. Terminal receipts
may be retained in bounded history, but an evicted ticket must return an unknown
or expired outcome, never start work again. Timeouts cannot expire accepted
operations. Ticket identity is not authorization and does not prove an effect.

For initial registration, the caller can retain a generation ID before asking
for allocation. The index journals that ID with the reservation in one write.
Retrying the same ID returns the original ticket through acceptance and
settlement. A different ID conflicts with the existing binding. This single
binding applies for the life of the initial registration in that incarnation.
The successful initial registration also seals an independent receipt in the
app envelope, in the same write that settles its ticket. That receipt survives
bounded terminal-ticket history and preserves the selected backend. Older
journals can recover this proof only from a matching successful ticket still
present in history; an expired ticket or registered fence alone is insufficient.
The live Ansible caller still needs durable storage for its generation ID.

The existing Ansible app role must acquire a registration operation through the
deployer's existing local control interface before inspecting the old
registration or changing configuration and secrets. The coordinator first
rejects new work for that app and settles its running deployment; queued work
is explicitly ended rather than started against a changing grant. The platform
then stages the registration, configuration and secrets as a new generation.
Secret material stays platform-owned and is never sent through the journal or a
public projection. A generation reference identifies all three together, so a
deployment reads one consistent snapshot rather than a mixture of files from
different registrations. Only after the staged generation is durable may the
platform publish it and report completion with the matching operation identity.
The coordinator observes the published generation and durably records completion
before reopening the gate. The platform keeps the prior generation until it is
safe to retire; it does not replace secret directories while a deployment is
reading them. The deployer's read-only access to registration, configuration and
secrets remains separate from the platform's write authority.

The existing push, poll, control and both restore paths must ask the same owner
before starting work. A queued request is revalidated against the current
registration and generation at start, not merely when accepted. Restore's
observation and its resulting request participate in this protocol; an
observation failure cannot authorize a deployment. Platform scripts become
thin clients of these commands, with no independent Docker stop, registration
deletion or release-record deletion.

Removal persists its identity and fenced intent first, rejects or ends queued
work, and waits for running work to settle. Only then may the runtime adapter
remove owned workloads. The platform removes registration and secrets as
coordinated effects, and the deployment owner retains a durable tombstone
containing the app generation and verified owned volume identities. Completion
requires observed workload removal and durable tombstone publication. A failed
or interrupted removal remains fenced; an absent registration alone is not
evidence of completion. Purge is a separate serialized operation: it requires
a completed tombstone, no current registration or conflicting operation, and
fresh successful ownership and attachment observations before asking Docker to
remove exactly the tombstoned volumes. Docker's in-use refusal remains a final
check, but project labels alone do not establish ownership. Unrelated volumes
are never selected for deletion.

At restart, the owner loads and validates durable state before opening request
listeners or starting restore and scheduled work. An incomplete operation
remains fenced while the owner observes its recorded effect and reconciles it;
it cannot assume an interrupted client or Docker command failed. In particular,
Docker may complete an accepted request after the client or coordinator exits.
Replays are limited to operations whose idempotence and current runtime evidence
make them safe; an ambiguous outcome requires an audited decision. An interrupted
registration cannot become available just because its caller vanished. An
interrupted purge retains the identities and outcomes of its individual volume
removals and never silently reselects a broader set. Reconciliation records
its decision and effects before proceeding; operator-facing projections show the
blocked phase and required action without secret values.

Activation requires a coordinated host upgrade: install the new owner, clients
and protocol-aware app role together, verify their versions and mounts, stop or
settle older in-flight operations, and refuse activation if any required path
can still bypass the owner. Import existing Compose registrations and readable
history as legacy observations, not verified active releases. Existing
interrupted legacy work is quarantined until its effects are reconciled; a
missing tombstone is not treated as permission to purge. Legacy volume ownership
requires an explicit, validated adoption procedure before destructive purge.
The protocol's durable format and activation marker must be versioned. A
supported downgrade checks that no managed operation or ownership state would
be bypassed and refuses if that cannot be established. Older tools do not know
this gate and have root privileges, so they cannot be made safe merely by
writing a marker; running an older playbook or directly mutating Docker or host
files after activation is outside the protocol and must be prevented by the
operational upgrade policy. This does not claim protection from a privileged
operator deliberately bypassing Kayra.

Acceptance must exercise the real control, Ansible and runtime paths, not only
an isolated state machine. Concurrent registration, deploy, restore, removal
and purge requests for one app must demonstrate that no incompatible effects
overlap; unrelated apps must still make progress. Fault injection kills the
coordinator or host-side caller immediately before and after each intent,
generation publication, workload removal, tombstone and individual volume
removal. Restart must preserve the fence and reconcile or report the unresolved
operation without repeating an unsafe effect. Tests cover stale operation IDs,
failed durable writes, an unavailable Docker observation, concurrent
registration versus purge, failed removal versus purge, attached and unrelated
volumes, and a crash after Docker accepts an action. Upgrade and downgrade
tests include existing registrations, interrupted legacy runs, unknown volume
ownership and older-client bypass attempts; verify that no unverified legacy
release is reported as active and no unresolved state authorizes purge.

Legacy filename-based destructive registry GC is refused on hosts managing
Swarm apps until GC understands image pins. The coordinator exports pins for
active, candidate, rollback and unresolved operations. Historical failed Swarm
tasks are not themselves evidence that the current application is unhealthy.

### Experimental registration-generation storage

The experimental storage library implements this layout and publication
protocol, but is not installed or called by the live platform. It provides
the platform-owned evidence needed by registration reconciliation;
it does not itself fence legacy host scripts or the deployment queue.
The platform remains the writer of registration, configuration and secrets. The
coordinator owns operation intent and verifies completion through a trusted
platform observation; it does not acquire authority to materialize secrets.

Use separate public and private trees under a dedicated root-controlled
registration root. Its ancestry must not be writable by the deployer or other
untrusted actors; the current deploy-owned platform directory is not sufficient:

```text
public/<app-key>/current.json
public/<app-key>/generations/<generation>/manifest.json
public/<app-key>/generations/<generation>/registration.json
private/<app-key>/generations/<generation>/manifest.json
private/<app-key>/generations/<generation>/configuration.json
private/<app-key>/generations/<generation>/secrets/<KEY>
```

The app key is a stable digest of the full validated app name. The coordinator
binds that name to an incarnation in its private index and provides the binding
to the platform through the lifecycle interface. This avoids using an unbounded
fleet name as a filesystem path component.

The strict version-one manifest and pointer each contain only `version`, `app`,
`incarnation`, `actionId` and `registrationGeneration`. The incarnation and
registration generation are distinct identities; the action ID belongs to that
incarnation. `registration.json` follows the validated registration contract.
The private tree holds configuration as JSON, a matching manifest, and exactly
the declared, validated secret keys as regular files. Metadata never contains secret values or hashes of secret
values. A validated generation reference selects both trees, and a deployment
uses that one reference for its whole snapshot. Prior generations remain until
no operation, rollback or recovery still needs them.

The platform alone can create and publish generations. The builder receives a
read-only public view and no private-tree mount. The deployer receives the views
it needs read-only and cannot modify a generation or pointer; it may read app
secrets as it does today. On Linux, provision root-owned parents and staging
directories, restrict traversal and read access with dedicated service groups,
and make finalized generation directories and files read-only to those groups.
For example, private staging may be `0700` with `0600` files, followed by
root-owned `0550` directories and `0440` files for the authorized deployer
group. Exact ownership and container UID/GID mappings must be checked during
host setup and in the lab. The public tree must not create an indirect path to
the private tree. These controls preserve the builder/deployer boundary; they do
not protect against root or an actor with Docker-socket privileges.

The publisher validates app names, incarnation and generation IDs, action IDs,
declared keys, file types and bounded inputs. It must prevent path traversal,
symlink substitution and replacement of existing generations using filesystem
primitives with tested semantics. In particular, an ordinary rename must not be
assumed to provide no-overwrite behavior. One possible approach is exclusive
creation of each final generation directory, populate it while no current pointer
references it, then publish only after validation and synchronization. A
preexisting or partially created generation is never silently overwritten or
assumed to be complete. Secret input does not appear in command arguments or
logs.

Publication runs under the same durable app fence as registration. After
persisting intent, the platform writes and synchronizes all public and private
files, applies and checks ownership and modes, and synchronizes the generation
directories and their parents. Only then may it write and synchronize a pointer
temporary file, atomically replace `current.json`, and synchronize the pointer's
parent directory. Before pointer replacement, the prior pointer remains
authoritative; incomplete new files are retained for reconciliation. After a
crash, the observer validates the pointer and manifest against the journaled
app, incarnation, action and generation, and checks both finalized trees. A
self-consistent pointer is not authority to accept a different journaled
operation.

Seeing a renamed pointer is not enough to prove it survived a crash: the
publisher may have stopped before synchronizing the directory. Before reporting
`applied`, the observation path must establish a tested durability barrier for
the pointer and containing directory while the same fence prevents a writer
from changing them. Any unavailable observation, invalid identity, incomplete
generation or failed synchronization remains unresolved. A successful
observation alone does not authenticate arbitrary client-supplied metadata; the
observer, its expected operation and the platform writer must be trusted and
bound by the owner. Existing `.env`, secret-directory replacement and
`apps/<app>.json` writes are separate effects and are not evidence of this
atomic publication protocol.

Adapter tests use isolated directories and synthetic secret values; they check
strict metadata, ownership and modes, denied access, key validation, symlinks,
non-regular files, collisions, incomplete generations and the absence of secret
values from metadata, logs and journals. Linux-host tests verify real bind mounts,
UID/GID access and synchronization behavior. Fault injection kills the publisher
before and after file synchronization, generation creation, pointer replacement
and directory synchronization; recovery must leave the previous generation or a
fully verified new one and keep ambiguous operations fenced. Concurrent
publication and deployment tests must exercise the shared lifecycle gate.
Integration remains disabled until the real Ansible, queue, restore, removal,
purge, upgrade and legacy-import paths participate in that gate.

### Indexed build retention

The explicitly enabled registration control path now exposes the exact verified
registration identity from its durable receipt. A public pointer alone is not
proof of successful registration. The builder resolves immutable public
registration generations without reading private registration material.

Indexed build requests require a full commit. Before calling the builder, the
coordinator journals registration identity, commit and an absolute 45-minute
deadline. The builder serializes preparations sharing a checkout and returns
registry manifest digests. The trusted composition validates the bundle again,
retains only validated fields in synchronized content-addressed files, then
journals the receipt. Retries after restart return that receipt without the
builder; missing or corrupted content requires intervention. Interrupted
preparations may repeat image building at the same commit and original
deadline. This is safe image preparation, not a claim of exactly-once execution
of arbitrary application code.

Indexed artifacts can carry validated rollout declarations. The legacy builder
request and Compose deployment parser continue to refuse those declarations.
Retaining an artifact neither admits its resource requirements nor authorizes
workload effects or promotes an active release. Runtime selection, admission,
normalization and the rollout state machine remain separate gates.

The image-pin projection verifies retained artifacts against recorded identity
and publishes image digests and unresolved build identities. It exposes no
Compose content or resolved secret material. It explicitly reports incomplete
coverage until active, candidate and rollback runtime plans are integrated;
legacy registry GC remains refused for coordinator-managed app names.

### Explicit experimental host setup

The platform role accepts an omitted-by-default `experimental_swarm` setting.
Enabling it requires an advertise address, declared host CPU/memory capacity
and platform overhead. Setup validates capacity against Docker, records intent,
initializes one manager and creates a uniquely owned attachable overlay. It
refuses unmanaged membership, conflicting networks, changed owned identities,
and implicit profile changes or retirement. Check mode observes without
creating authority files, a cluster or a network. A root-owned public authority
file records immutable cluster, node, network and budget identity; it contains
no join tokens or application secrets.

The optional platform override retains Compose discovery and adds Swarm
read-only discovery plus Traefik's overlay attachment. The existing deployer
receives a read-only authority mount; the builder receives none. No additional
Docker-socket holder or internal service is introduced. The platform integration
lab verifies mixed Compose/Swarm routes with real TLS and denied API writes.
This establishes infrastructure connectivity only. Ordinary fleet app
registration still selects Compose; the live Swarm application adapter,
resource admission and coordinated rollout remain subsequent integration work.

### Persisted runtime selection

Initial indexed registration now allocates its runtime with the generation
before publication. A retry with a different backend is refused, including
after restart. Older indexed allocations default to Compose. The public policy
command reports the backend only after registration has a verified receipt.
Immutable generation readers require an explicit runtime; the legacy reader
continues to refuse Swarm registrations.

A root-side Swarm registration requires current platform authority, matching
Docker cluster/node/overlay identities, explicit CPU/memory grants bounded by
workload capacity, and an explicit maintenance grant. It refuses existing native
objects when first claiming a name. Generation publication also refuses backend
conversion. A Swarm artifact must contain validated rollout metadata, and build
preparation checks the public backend against the coordinator's allocation.

These checks are live only in the explicit lab registration path. Normal fleet
app registration still refuses Swarm until the application adapter and admission
path are integrated; infrastructure enablement does not convert an app.

### HTTP plan proposals

The indexed control path can preview an already-retained Swarm artifact through
typed coordinator ports. The runtime description parser accepts an explicit,
narrow Compose subset and performs no interpolation, filesystem reads or Docker
effects. Unsupported fields are refused. The coordinator revalidates rollout
requirements, exact artifact/registration identity, owned image digests,
platform host grants and per-release resource grants before returning an
immutable proposal. Host admission must separately account for existing
workloads and actual candidate overlap.

The proposal uses a services map and route list, pins platform authority and
configuration identity, and retains environment inputs as literal app values or
configuration/secret references. It never materializes a secret. The live lab
previews with the builder stopped and the fixture secret temporarily absent.
The response explicitly reports `admitted:false`; preview neither authorizes a
runtime effect nor marks a release active. The initial supported subset and
reproduction commands are documented in the registration-generation lab.

### Native runtime fencing evidence

The platform lab now verifies Docker service-version fencing through a bounded
Unix-socket transport in the existing deployer container. A metadata-only update
advanced the service version without replacing its task. A stale update was
refused with HTTP 500 on the tested Docker 29.9.3; coordinators must inspect
owned runtime state after an unsuccessful write rather than treating an HTTP
status as proof of failure. Mutation intents must retain the exact service ID
and expected version before effects, and retries must never rebase onto a fresh
version implicitly. The transport performs no request retries.

The tested removal design retains a native zero-replica service as an ownership
tombstone. It clears container environment and network attachments and releases
the VIP while reserving the service name. That name reservation prevents a late
create from resurrecting removed workloads. Recreation uses a versioned update
of the reserved object; a stale versioned removal cannot affect it. Ordinary
removal must therefore stop and fence workloads without deleting the native name
reservation. Volume purge remains a separately fenced operation; a purged volume
identity must never be reused for newly created data. No per-release custom
traffic switch is introduced.

The typed native adapter now renders admitted HTTP plans with platform-generated
TLS/VIP routing, node placement, explicit resources and 30-second update/rollback
monitoring. Its writer takes the recorded service ID and version, clamps each
request to the original absolute deadline and never retries or refreshes the
version on replay. Failed or interrupted writes remain uncertain until observed.
Normalized observations distinguish service labels from the current task template,
including automatic rollback, and never publish Docker environments or health logs.
Metadata fences preserve tasks; removal installs a zero-replica, secret-free,
network-free DNSRR tombstone instead of deleting the native service name.
Docker retains `PreviousSpec` after the first update, including the old
environment. Removal therefore requires a second separately journaled,
version-fenced tombstone update and a clean-history observation before settlement.
The adapter also compares desired fields of the actual native spec against the
retained plan and materialized inputs; unchanged ownership labels alone do not
prove convergence. This comparison returns a boolean without exposing values.

Native intents distinguish the logical lifecycle action from its stable effect
step (`apply`, `restore`, `fence`, `remove` or `scrub`). Both tombstone writes
therefore remain under one removal identity while the scrub changes the task
metadata needed to retire `PreviousSpec`. If removal races an unacknowledged
first create, it can create the zero-replica name reservation itself; a delayed
candidate create then conflicts instead of resurrecting the workload. Successful
removal still requires observing all tasks stopped and retained inputs cleared.

Desired verification treats the native task template as the effective release.
Swarm can restore A while retaining B's service-level action metadata. Only those
three mutable service-level metadata labels are excluded from the comparison;
ownership, routing, task labels, materialized environment and workload settings
must still match the recorded release exactly.

The isolated adapter probe verifies these paths against the real engine and TLS
router, including replacement, stale-write rejection and same-ID recreation.
It uses a disposable unregistered fixture. Lifecycle authorization, integrated
coordinator recovery and continuity under load still require their own tests.

These are runtime prerequisites established by the lab. Application admission,
release promotion, compensation and lifecycle commands still require integrated
coordinator implementation and fault-injection tests before these guarantees can
be attributed to Kayra.

The coordinator index now has an internal resource-accounting interface for the
first HTTP subset. It retains and validates the exact normalized plan before
journaling a reservation. Each app contributes one charge: its verified resource
baseline or the full replacement-and-recovery envelope (draining A + B + restored A) while an operation remains unresolved.
A retry keeps the original plan, sequence and absolute 90-second deadline;
expiry never releases capacity. Settlement requires the trusted lifecycle owner
to establish target, previous or absent runtime state. Stale settlements are
refused. The standing platform budget includes ambient legacy Compose workloads;
it is an operator declaration, not a guarantee against global host exhaustion.

These accounting methods are deliberately unavailable through registration
control. The internal HTTP path now binds a retained plan and request UUID to a ticket
and lifecycle fence in one app-journal write, then records global admission
using that original deadline. It persists exact native CAS intent only after
matching admission. An internal execution path now dispatches the recorded native intent, observes
convergence and promotes a release only after fresh routed readiness. Recovery now observes native rollback, compensates to the recorded previous
plan, or clears an unverified initial release. The optional indexed composition
now schedules recovery; ordinary deployment/client integration is still required. Retained
plans contain configuration identities and secret key references only. Rolling
HTTP admission refuses changes to route, backend port or service identity,
because a shared service VIP must continue routing the old tasks correctly.

HTTP request recovery reads the already-retained immutable plan; it never
reconstructs it from a moving branch or current platform settings. A lost
acknowledgement returns the same request, ticket, action and deadline. Native
intent replay returns `reconcile`, and replacing its expected Docker version
is refused. Requested/desired and certified active/last-known-good references
are separate fields; preparing or admitting a candidate creates no active proof.
The preparation interfaces dispatch no workload writes. Execution remains an
experimental indexed interface. Its local control route accepts only an app,
full commit and stable request UUID for a retained artifact; the normal legacy
deployment route and fleet CLI remain unchanged.

The current experimental HTTP journal bounds non-evicted request UUID history at
1,024 entries per incarnation and refuses further requests at that limit. It
never silently reuses an evicted UUID. Long-lived history compaction or separate
immutable receipt storage must preserve that property before this limit can be
relaxed. This is a storage guard, not a production-retention guarantee.

HTTP promotion now seals the native service identity/version, verified plan and
commit, active/last-known-good references, lifecycle settlement and successful
ticket in one app-journal write. It requires the expected task identity and
healthy state, matching actual native settings, completed runtime convergence,
all older tasks stopped, and a fresh routed TLS check for the same request.
Historical failed tasks do not themselves make the current service unhealthy.

Only after that proof is durable does the owner settle the overlap charge to
the target budget. A crash between those writes leaves conservative accounting;
restart settles it from the sealed proof without another service update. The
older direct reservation/release API has been removed, leaving lifecycle intent
as the admission entrypoint.

The platform materializes configuration and secrets from the exact registered
generation immediately before runtime use. It checks the configuration identity,
operator grants and declared bindings and returns only the service's environment.
Resolved values never enter journal records or public observations. Routed
readiness connects to the platform router with app SNI/Host, verifies TLS, uses
a fresh connection and neither redirects nor retries. Lab trust uses a public
CA certificate, not a private TLS key or the router's certificate directory.

The component lab uses trusted fixture build inputs, real journals, Swarm and
TLS. It kills the writer after update acknowledgement and reconstructs promotion
with zero repeated writes, the same service ID and the original deadline. It
does not replace the end-to-end builder/registration or continuity matrix tests.

Recovery records an absolute deadline once, capped at 90 seconds after the
original update deadline. Expiry holds the operation and its full charge for
intervention. It never creates fresh scheduling time after restart. Each restore,
metadata fence, zero-replica removal and input scrub has an immutable effect
identity and expected native revision. A superseded revision permits a new
recorded attempt; it never overwrites the earlier intent. Explicit restoration
pauses on failure, so Swarm cannot roll it back to the rejected candidate.

Before settling recovery, every recorded native write must be fenced by a newer
revision of the same owned service, or by its still-reserved name for initial
creation. Merely finding the previous release healthy is insufficient: a delayed
candidate write may still arrive. Metadata fencing preserves the task template.
Initial release cleanup keeps a zero-replica name barrier and waits for drained
tasks and cleared current/previous private inputs before releasing capacity.

A failed candidate retains its requested identity; desired, verified active and
last-known-good point to the restored release only after native and fresh routed
proof. The failed receipt and lifecycle settlement are atomic. Host accounting
settles afterward from that receipt, including on restart or before the next
request. Automatic rollback disruption is not described as uninterrupted service.
These paths remain internal and still require the integrated continuity matrix.

The coordinator now exposes a validated deployment-status projection through its
own interface. It omits private journal tickets, native effect authority,
configuration and secret bindings. Requested, desired, certified active and
last-known-good release references are separate. A held operation reports
`inspect-and-resolve`; indexed Compose applications remain `legacy-unverified`.
The projection explicitly reports `runtimeObservation: not-observed`: historical
release certification must not be presented as a fresh workload-health check.
The local experimental status query publishes this projection. Ordinary client
presentation and live observations remain subsequent integration.

The owner also derives a restart work list from validated journals, including
terminal operations whose global resource accounting is still pending. It never
creates request IDs, refreshes deadlines or includes held operations for automatic
retry. One scheduling round reconciles independent apps concurrently and reports
port failures without exposing their private error bodies. The optional indexed composition now schedules these rounds in the existing
deployer process when public/private registration inputs and explicit Swarm
authority are configured. It begins from the persisted index on startup, never
initializes an absent index implicitly, runs one round at a time and waits for
an in-flight round when closed. Timer and reporting ownership stay in the
composition root; the decision logic owns neither. No additional process or
Docker socket holder is introduced, and the ordinary fleet deployment commands remain unchanged.

The experimental indexed lifecycle control now prepares a retained build through
`/deployment/prepare` and returns a public receipt with the original request,
plan and deadline. Caller-provided native revisions, configuration, secrets or
runtime overrides are rejected. The host must explicitly enable Swarm and the
app must have a verified managed registration. Replaying a request never rebuilds
its plan, changes its commit or refreshes its deadline. `/deployment/status`
returns the coordinator projection. Both use the existing loopback listener and
internal `ctl lifecycle` interface; ordinary app deployment/client integration
is still pending.

The real deployer lab now exercises builder artifact retention, private platform
materialization, host admission, native creation, routed TLS readiness, promotion
and same-request replay through those interfaces. Its public lab CA is mounted
read-only only in the explicit lab overlay. A managed fixture remains under the
coordinator's ownership until the lifecycle removal integration is available;
raw native deletion must not bypass its records or active charge. This proves
one initial deployment, not replacement continuity, migrations or full completion.

HTTP cancellation records its request time once and never refreshes an existing
recovery deadline. Before native intent, the owner can atomically cancel the
ticket and restore desired state without workload effects. After dispatch it
uses the same fenced recovery protocol as failure, certifies the previous or
absent outcome, then seals a cancelled receipt. A delayed old write cannot arrive
after settlement, and cancellation of a finished UUID cannot affect a newer
operation. Expired or held recovery remains an intervention case, with its
capacity and image references retained. The public status includes cancellation
intent separately from recovery failure reason. Recovery recognizes the accepted
task template before its task exists, so scheduling delay cannot trigger another
restore. Promotion still requires the actual healthy task and routed readiness.

A real native compensation probe observed three concurrent containers while A
drained, B existed and a restored A started. First-HTTP admission therefore
reserves `2 * previous + target`, rather than only A+B. Per-release grants remain
separate from that temporary host charge. New apply/restore effects cannot use
an older undersized pending reservation; metadata fencing and cleanup that need
no additional workload copy remain possible. This is conservative accounting,
not a guarantee against global host OOM or Docker defects outside this scope.

## One-shot execution foundation

The migration runtime primitive now separates container creation, start and
fencing behind a typed port. Its immutable plan binds an app-owned image
digest, stable run/step/purpose/attempt, input references, explicit limits and
absolute deadline. Materialized values enter only the native create request.
`KAYRA_OPERATION_ID` identifies the logical run and step across attempts.
Automatic restart and removal are disabled. The current primitive supports no
mounts; it refuses image-declared volumes before starting application code.

The coordinator persists start intent before its single Start dispatch. An
interrupted start is observed, never repeated, even if Docker still reports
the container as created. Terminal exit evidence is captured before removing
the exact container ID and reserving its stable name with an inert, never-started
container. This fences delayed Start-by-ID and Create-by-name requests. The
cleanup deadline is separately persisted, bounded to 30 seconds beyond the job
deadline, and never refreshed on restart. Unfinished cleanup holds the record.
The barrier retains neither resolved inputs nor application network access.

Execution completion means runtime evidence and fencing are durable. Its
outcome remains separately `succeeded`, `failed`, `unknown` or `not-started`;
`complete` never turns an ambiguous migration into an applied migration. A
container fence cannot revoke a database request already in flight. Application
status probes and audited recovery must resolve those semantic outcomes.
Post-rollout checks require their own execution inside admitted app containers;
they are not implemented by cloning a one-shot migration container.

This primitive is not a deployment entrypoint and enables no new app capability.
The lifecycle owner must still provide admission, retained dependencies, plan
validation, ordered migration sequencing, status-probe interpretation and
operator recovery before migration-bearing apps can be accepted. Existing
HTTP admission continues to reject migration and worker declarations.

Job creation prepares its exact app-owned image digest when the host cache
is cold. Pull progress or HTTP success is not image evidence: the adapter
independently inspects the immutable reference before creating the job. Image
preparation preserves the original deadline and supplies no Start authority.

A duplicate pending Create can arrive after the executed container is removed
and before the name barrier is installed. Recovery records such additional
owned IDs as cleanup targets before deleting them, without replacing original
execution evidence or starting them. At most eight additional IDs are handled
within the original fencing deadline; exhaustion holds the operation. Only
then can the final name barrier certify that delayed creation is fenced.

Job scheduling and execution use separate persisted bounds. A normalized job
may provide a start deadline and an execution timeout under its fixed overall
ceiling. Image preparation and queueing consume the start window. Immediately
before its only Start dispatch, the coordinator persists the execution deadline
from the current time and declared timeout, capped by that overall ceiling.
Restart reuses this timestamp; it never grants another execution window. Older
records retain their already-recorded ceiling rather than receiving a new one.

Recovery records scheduling or execution expiry separately from actual exit
evidence. Docker's completion timestamp can establish that a job finished
before its execution deadline while the coordinator was absent. Late success
retains both the successful exit and an execution-expired flag; execution
completion must not be mistaken for a timely rollout outcome. Missing runtime
observations cannot postpone expiry to the larger overall ceiling. Capacity
remains held until execution is fenced and the lifecycle owner settles it.

Docker containers provide no native hard execution deadline in this primitive.
A job can continue while the coordinator is absent. After restart, the owner
observes it and resumes bounded fencing against the original deadline. This
cannot undo an already-issued database request; app status probes and recovery
declarations remain necessary. Applications needing database-side statement or
transaction limits own those limits.

## Application status-probe response

A successful status-probe process writes exactly one JSON value to stdout:
`{"version":1,"outcome":"applied"}`, with `not-applied` or `unknown` as the
other outcomes. The process must exit zero for any semantic result. A nonzero
exit, unavailable output, invalid UTF-8, malformed JSON, unknown field or
oversized response supplies no authoritative semantic outcome. Kayra treats
those cases as unknown. Stderr is never interpreted as a status response.

The runtime reads at most 1 KiB of complete Docker non-TTY stdout frames and
accepts a JSON response of at most 256 UTF-8 bytes. Truncated tails and raw TTY
streams cannot establish an outcome. Only the normalized enum enters the
coordinator record before fencing removes the original container. Raw probe
stdout and materialized inputs never enter journals or public reporting. Job
execution completion and successful process exit remain distinct from the
application's semantic outcome.

The isolated probe component covers every declared outcome plus malformed
private output, oversized output and an unsuccessful process that prints an
otherwise valid applied response. This implements evidence collection, not
ordered migration admission, automatic unsafe retries or operator resolution.

## Ordered migration phase ownership

The migration-sequence owner retains a private normalized description binding
the deployment identity, app/run scope, ordered app declarations and job
templates. Scope, commands and deadlines cannot be supplied through a template.
Each scheduled job is revalidated against that retained description before
effects. The parent must provide lifecycle fencing, durable resource admission
and materialization from its immutable input generation; the phase owner does
not interpret fleet configuration or grant itself authority.

Child job records occupy private views inside the same exclusively owned
journal, with no extra writer, socket holder or RPC service. Step advancement
requires fenced execution evidence. Applied/completed timestamps are persisted
and must precede the original sequence deadline, including after slow artifact
reads. A retry uses a new attempt identity under the same logical run and step,
only for explicitly replay-safe work, bounded by its original execution window
and eight attempts. Status probes have their own persisted deadlines and can
resolve an interrupted or expired migration. Unsafe work is never automatically
rerun; not-applied and unknown probes hold the sequence for audited recovery.

The application fixture owns its data effects and deduplication. Native tests
exercise effect-before-failure, unsafe probe recovery, explicit holds and
SIGKILL before Start, after Start acknowledgement and after step advancement.
This phase library enables no app capability by itself. Indexed parent ownership
and admission are described below. Public deployer integration, maintenance and
audited operator resolution remain subsequent delivery work.

## Complete rollout plans and workload projections

The private version-two rollout description retains full orchestration metadata
separately from an independently validated version-one HTTP workload projection.
The complete plan and projection have distinct immutable digests. Runtime
effects consume the projection; the parent coordinator must bind its native
proof to the complete plan and sequence migrations before workload mutation.
Legacy HTTP compilation still rejects migration-bearing artifacts, so producing
a projection does not activate a deployment path that silently skips migrations.

The current normalizer accepts one compatible rolling HTTP service and ordered
migrations referencing that service's app image. It rejects workers, retained
dependencies, maintenance, checks, unsupported job grace settings and mismatched
projections before admission. It preserves exact image/input references and
operator policy without materializing secrets. Migration descriptions bind the
logical run to the complete-plan digest. The operation's finite upper budget
accounts for scheduling, shared retry windows, bounded cleanup and HTTP
update/recovery. The format itself is neither an admission grant nor an enabled
app capability; the indexed parent below supplies lifecycle ownership.

## Indexed rollout preparation

The application lifecycle writer can now accept a complete rollout plan under
the same exclusive app fence and ticket sequence used by HTTP deployment.
It retains the complete plan, workload projection and migration description
before accepting intent. The ticket and host resource charge identify the
complete plan, while the native workload projection remains separately pinned.
Ordinary HTTP requests cannot enter while this operation owns the app fence.

Acceptance records the original scheduling and total operation deadlines.
Admission reserves a conservative peak covering the previous application,
candidate, migration job and HTTP recovery overlap. A crash between reservation
and the app's admission marker retains the reservation; replay checks the
original identity and deadline. Admission expiry never frees capacity by itself.

Migration state and individual execution records occupy private views inside
the same app envelope. Every runtime effect rechecks the matching host-wide
charge. Step advancement retains fenced evidence. An unresolved step keeps
the lifecycle action and reservation held. Neither job completion nor an
`applied` status probe certifies a new active application release.

Only completed migration preparation can persist the HTTP handoff deadline.
It is bounded by the original operation budget and is not refreshed on restart.
HTTP-only complete plans receive a finite preparation window too. These owner
methods remain internal: the public deployer still accepts only the legacy
HTTP path and rejects migration-bearing artifacts. Internal HTTP handoff is
described below. Audited resolution, cancellation and terminal settlement before
handoff must be connected before enabling that capability. Maintenance, retained
dependencies, worker behavior and normal fleet opt-in remain subsequent work.

## Complete rollout HTTP ownership

The internal complete-rollout owner now drives admission, migration preparation,
HTTP handoff, convergence, routed readiness and release promotion. Handoff uses
the parent's existing action, ticket and resource reservation. The separate
HTTP execution deadline is the value already persisted after migrations; it is
never minted again on restart. An expired handoff cannot create HTTP intent.

Native task labels and service comparisons identify the immutable workload
projection. The HTTP request and verified release additionally bind the complete
deployment digest. Tickets, published requested/desired/active identities and
host resource accounting identify that complete deployment. Recovery retains
both identities when certifying a restored release. Legacy HTTP journals omit
this additional field and retain their original interpretation.

Completed parent records retain their migration evidence in private history.
Every HTTP projection referencing a complete deployment must match its parent,
including the action, ticket, commit, workload digest and handoff deadline.
New complete requests archive only a terminal parent; an unsettled reservation
is reconciled from its sealed HTTP outcome before another admission. Once an app
uses complete rollouts, ordinary HTTP admission cannot bypass this ownership.

Published status exposes preparation phase, current step, original deadlines and
required intervention before HTTP intent exists. It preserves the historical
verified release and omits private execution records and materialized inputs.
After handoff, the existing HTTP operation projection reports convergence and
recovery. Restart work lists dispatch complete rollouts to their parent owner;
the legacy HTTP work list excludes those child operations.

Native component tests use fixture registration/build ports with real resource
observations, one-shot containers, Swarm services and TLS readiness. They cover
initial complete deployment, SIGKILL after HTTP acknowledgement, automatic
rollback to the previous complete release and a migration probe that remains
unknown. They establish neither public deployer integration nor database-volume
safety, and carry no HTTP continuity claim. Public acceptance remains disabled
pending audited resolution, cancellation of started preparation and integration
through the normal platform/builder/coordinator composition.

## Unstarted rollout settlement

A complete request can now be cancelled before migration or HTTP intent exists.
The private completion certificate records that unstarted state, the outcome,
timestamp and previous verified deployment identity. The lifecycle fence and
ticket settle atomically with this proof, before releasing resource capacity.
Runtime absence is never used to infer that an application command did not run.
Once preparation intent exists, this narrow cancellation path refuses to claim
an unstarted outcome, even when no runtime container is visible yet.

If the coordinator dies after recording completion but before settling the
resource book, restart retains a conservative reservation and reconciles from
the sealed proof. A subsequent request performs the same reconciliation before
archiving that parent. Repeating an old cancellation cannot release a newer
request's reservation. Published status keeps the cancelled/failed candidate
requested and restores the previous release as desired, without inventing an
active certificate or an HTTP update deadline.

Admission expiry distinguishes an absent reservation from an accepted decision
whose app marker was interrupted. The former records an unstarted failure at
the original scheduling deadline. The latter reconstructs the original admitted
decision without refreshing its deadline or total preparation budget. Neither
path authorizes a new application effect beyond its original phase deadlines.

Native tests kill the writer immediately before a synchronized reservation,
after that reservation but before its app marker, and after a cancellation
certificate but before capacity settlement. These tests use the same locked,
synchronized filesystem journals through a typed storage factory. They wait
past the original admission deadline and forbid application runtime effects.
They validate lifecycle/admission recovery with fixture build inputs; they do
not validate image availability or app runtime readiness. Started migration cancellation and audited resolution use the separate paths below.

## Cancellation during preparation

The application owner persists cancellation intent before further effects.
Before HTTP handoff, it stops migration Create/Start and retries, fences the
current job under its original bounded authority, and may run its already
declared status probe. It never begins a successor migration or creates an
HTTP candidate after cancellation. Unknown outcomes retain admission and
require cleanup and/or audited resolution. Termination alone proves no data
outcome and does not undo database writes.

A cancelled operation completes only with a recorded proof of the known
migration prefix and quiesced attempts. A never-authorized tail is distinguishable
from a dispatched command: the journal contains no execution intent, and an
operator assertion checks current runtime absence before resolving an earlier
ambiguous effect. A running/foreign object blocks that assertion. Applied data
stays applied; Kayra keeps the previous compatible release without down-migrations.
Original execution evidence, image/configuration identities and deadlines stay
available. Completion and ticket/fence settlement commit atomically before
releasing the resource charge. Restart can reconstruct either side of a lost
acknowledgement without replaying an unsafe job.

After HTTP handoff the same request uses the existing bounded HTTP cancellation
and restoration protocol. Its parent intent is recorded with that transition.
Cancellation of already terminal HTTP work returns its existing outcome.
`app.deployment.status` and `app.deployment.cancel` are catalog operations across
CLI/API/UI/MCP; the command line spells them `app deployment status|cancel`.
Complete-plan cancellation receipts use version 2 while existing HTTP receipts
remain version 1. Status exposes the cancellation timestamp and distinguishes
cancelling, held and cancelled. A historical verified active certificate is
never replaced merely because a cancellation request was acknowledged.

## Complete-plan indexed control

When the trusted indexed composition is explicitly configured with host migration
policy, its existing prepare and preview interfaces use full version-two plans.
The composition reads the verified registration, retained builder artifact,
private configuration identity, Compose description and root-owned policy. It
validates these again before the coordinator records intent. Requests supply only
app, full commit and request identity; callers cannot supply grants, a runtime,
a ceiling, private values, phase decisions or replacement deadlines.

Preview validates full ownership and declarations without admission. Preparation
retains the full plan and migration description, then the existing owner runs
migrations before creating the HTTP child. Version-two receipts retain the full
plan identity and original total deadline. Repeated requests reconstruct the
recorded outcome without recompilation. Existing version-one HTTP requests keep
their original receipts and controller, including after full-plan support becomes
available; unsupported declarations never fall back to HTTP-only deployment.

These are indexed experimental interfaces. They do not enable ordinary fleet
registration, webhook routing, workers, maintenance or retained dependencies.
Normal Compose startup still loads no optional experimental contract packages.
The remaining public pipeline and lifecycle/client acceptance is required before
claiming the integrated experiment complete.

## Host migration timeout policy

`swarm_migration_timeout_seconds` is a fleet host setting, bounded from one to
86,400 seconds, defaulting to ninety. Explicit experimental Swarm setup publishes
`/var/lib/kayra/swarm/policy/migration.json` as a root-owned read-only document
under the existing exclusive platform setup lock. Check mode reports pending
publication without creating directories or changing Docker. Invalid or untrusted
existing policy requires intervention rather than silent replacement.

The deployer receives only the public policy directory through a read-only mount;
atomic replacement is visible without retaining an old file inode. The platform
reader validates file ownership, mode, link count and content. Admission must copy
the validated ceiling into the immutable full plan before issuing any job.
Changing host policy affects future plans and never extends an existing run's
execution, handoff or recovery deadline. The setting does not enable migrations
or supply app commands. Public migration-bearing admission remains disabled until
the pipeline and remaining acceptance requirements are implemented.

## Expired HTTP handoff after preparation

If preparation is ready but no HTTP child exists when its original handoff
window expires, the coordinator records a terminal failure with the known
migration prefix and previous release identity. It settles the lifecycle ticket
and fence in that same synchronized journal replacement, then releases the
candidate reservation. Restart reconstructs either side of that boundary.
No HTTP child, replacement deadline, migration retry or down-migration is created.
Applied data stays applied under the admitted rolling compatibility declaration.
An existing HTTP child keeps ownership of its own convergence/recovery protocol;
an already accepted cancellation keeps its cancelled outcome.

The public preparation projection reports the preserved previous release (or
absence of an active release) and normalized known step outcomes. It contains
no private job descriptions, SQL, environment, or operator rationale. Historical
release verification does not assert fresh runtime health. A stale completion
cannot release a newer operation's reservation.

## Audited recovery of expired job cleanup

`app.migration.cleanup` requests a separate audited action for a held migration
or probe attempt. The operator supplies an action UUID and reason; the existing
privileged control transport supplies the actor. The parent persists that
identity and a thirty-second absolute cleanup deadline before effects.
`app.migration.cleanup.audit` publishes its audit and normalized fencing proof.
The CLI spells the read command `app migration cleanup-audit`. Cleanup receives
no application Create/Start interface and cannot materialize an environment.

Recovery checks the existing app lifecycle fence, pending resource charge and
immutable job description, records each exact owned container ID before
removal, and recreates only the inert name barrier. It never rewrites the
original execution evidence, job deadline or deployment deadline. Interrupted
cleanup reconstructs its original action and deadline from the same app
journal. Expiry holds that action; another explicitly requested UUID can grant
a new bounded cleanup action, retaining its predecessor. A maximum of eight
cleanup actions per attempt and eight observed container identities per action
bounds stored recovery history and retries.

When fencing completes before the original migration deadline, the existing
sequence reconciles its captured execution evidence and app-declared recovery
policy. An unsafe ambiguous outcome runs its declared status probe before
operator outcome resolution. Unknown results stay held; a confirmed applied
result may proceed through normal convergence. Cleanup completed after that
deadline stays held and cannot run a new probe. Data outcomes are never inferred
from container deletion, and remote database work may outlive a stopped client.

The composition root runs the existing HTTP and complete-rollout scheduling
loops in the same privileged process with disjoint work lists. No new socket
holder or RPC service is added, and public migration-bearing admission remains
disabled pending public pipeline integration and the remaining acceptance requirements.

## One-shot image health isolation

Migration and status-probe containers explicitly disable inherited image health
checks. The adapter checks `Healthcheck.Test = ["NONE"]` before Start, alongside
restart, volume and command checks; earlier prepared containers missing that
setting cannot be started by the updated adapter. Inert name barriers also
carry the disabled setting. Long-running service readiness checks remain part
of the admitted Compose description. This prevents an undeclared concurrent
image command from executing alongside an admitted one-shot operation.

## Audited resolution of fenced migrations

The indexed owner now accepts an explicit `applied` or `not-applied` assertion
for a named held run and step. The normal operation catalog exposes
`app.migration.resolve` and `app.migration.audit` across CLI, API, UI and MCP.
The existing loopback operator control transport supplies the actor identity;
request bodies cannot supply an actor, execution command or replacement deadline.
The recorded actor identifies that privileged local control credential class,
not a verified human identity. Audit reasons are bounded, single-line text and
belong in the private audit report, not the general deployment projection.

Resolution requires completed cleanup for every attempt, hash-verified immutable
job descriptions, and a fresh observation of every exact owned, never-started
name barrier. Absent, foreign, running, substituted or unavailable objects block
resolution. This operation does not repair an unfenced attempt or extend its
expired cleanup authority. Such cleanup uses the separately bounded operator recovery operation below before an outcome can be asserted.

The exclusive app journal writer atomically records the immutable audit and
parent transition before further effects. Timely `applied` assertions advance
preparation under its original deadline without changing earlier runtime or
probe evidence. `not-applied`, or an `applied` assertion after that deadline,
fails the candidate without retrying its unsafe migration or running a
down-migration. The historical active release stays unchanged; capacity settles
only after the persisted completion proof. Repeating the same decision returns
the original receipt; a conflicting assertion fails. Restart can settle a
completed decision whose acknowledgement or resource-book update was lost.

These commands can recover existing indexed experiment operations while new
experimental admission is disabled. They do not enable migration-bearing apps
through the public builder/deployer pipeline. Worker, maintenance, data-retention and public pipeline acceptance remain required work.

## Current host authority during recovery

A durable resource reservation records an accepted scheduling decision. It is
not a substitute for current runtime authority. Admission markers, migration
Create/Start, HTTP handoff, replacement, promotion and restoration require a
fresh normalized observation matching the pinned node, cluster, overlay and
declared host budgets. Replaying an old reservation preserves its deadlines and
accounting but cannot bypass this check.

Owned fencing and cleanup remain available when host readiness is unavailable.
They use exact owned identities and their existing bounded deadlines; they do
not authorize another workload. Native component tests inject unavailable host
observations before Create, between Create and Start, and after an acknowledged
Start. The first two execute no app command. The last retains fenced completion
evidence while HTTP handoff stays blocked. These tests change no actual Swarm
role or host configuration and establish no host-loss availability guarantee.

## Delivery and acceptance

Each stage preserves the existing Compose compatibility path until its
replacement is explicitly ready:

1. **RFC and model:** document ownership, dependencies, contracts, trust,
   state transitions and compatibility, with deployment, restart recovery,
   maintenance and removal flows.
2. **Behavior-preserving extraction:** separate builder, platform integrations,
   deployment logic and runtime effects; preserve Compose commands, queue,
   reporting and upgrades. Move shared reporting contracts out of deployer
   internals. Enforce import rules and retain builder isolation.
3. **Durable foundation:** journal, stable identities, admission leases,
   explicit promotion, recovery, lifecycle commands and public read models;
   preserve readable legacy history without inventing a verified release.
4. **Experimental HTTP:** explicit host Swarm setup, read-only discovery and
   overlay connectivity alongside Compose, strict adapter, admission,
   health-gated replacement and bounded cancellation. Routing remains
   platform-owned.
5. **Migrations, workers and maintenance:** sequencing, ambiguous-outcome
   recovery, whole-app compensation, standby handoff and audited intervention.
6. **Lifecycle and clients:** lifecycle-owned restore/removal/purge, accurate
   health and consistent phase/recovery reporting across CLI, API, UI, MCP and
   run pages; refuse unsafe legacy GC and export pins.

Acceptance includes existing Compose golden, policy, client-parity and upgrade
tests; mixed-backend routing and lifecycle on one host; and contract and
architecture tests. Fault injection must kill the coordinator before and after
admission, migration creation/start, service update acknowledgement, rollback,
promotion and removal. Restart must not duplicate unsafe actions, extend
deadlines or promote prematurely. Tests cover replay-safe and probed migration
recovery, unknown outcomes, unsafe rollback and operator resolution; HTTP
continuity and failure through the real deployer; worker draining, redelivery,
effect-before-ack duplication and singleton handoff; and maintenance downtime.

Admission tests cover competing requests, exhausted reservations, candidate
OOM, bounded ENOSPC, removal races and restart with outstanding admission.
Data tests verify volume identity and retained writes across deployment,
rollback, removal and recreation, and refuse purge of registered or attached
volumes while preserving unrelated data. The full platform upgrade lab exercises
TLS, Authelia and real deployment records. All six stages and their acceptance
tests must pass before calling the experimental integration complete.

### Integration prerequisites found during implementation

The initial deployment-plan fragment never authorized effects or entered
persisted release history. It has been replaced by the managed service contract,
which contains normalized runnable declarations and exact ownership/input
references. Existing admitted HTTP and version-two rollout plans remain readable
under their original contracts. The real HTTP/migration pipeline validates
immutable image digests, registration/grants and input generations; the richer
service contract still needs group admission, sequencing and native integration
before authorizing retained dependencies, workers or singletons.

The existing Docker socket proxy grants broad read access by API prefix. Adding
Swarm discovery must not assume that read-only access protects secrets: Docker
inspect and service descriptions can expose environment values, and container
archive endpoints can expose files. A narrower, tested endpoint policy and a
review of configuration exposure are prerequisites. Discovery must continue
to work for existing Compose apps, and platform-owned routing must be generated
for Swarm services rather than accepted from app labels.

The existing registry GC does not know the images needed for an interrupted
operation. A registration scan alone cannot safely authorize destructive GC:
removal can delete a registration before workloads or recovery evidence are
gone. Establish durable backend history and shared fencing before Swarm is
first enabled, and refuse legacy GC when ownership or recovery state is
uncertain. Until a real preview is implemented, a GC dry-run request must fail
without invoking the destructive script.

## Evidence and limits

The isolated single-node Swarm labs establish that, for their pinned versions,
VIP discovery passed the tested HTTP continuity cases; post-readiness failure
still caused a measured interruption before recovery. Separate fixtures
exercised migration compatibility, app-owned worker idempotency and singleton
coordination, and resource exhaustion. These are feasibility evidence, not
proof that Kayra's actual deployer, persistence, platform security or upgrade
path implements the proposed guarantees.

The indexed complete-plan control has also passed a targeted real-builder
integration with TLS routing: 3,029 short requests at 20 requests/second, zero
failures and zero premature candidate exposure. During an unsafe migration,
the deployer was killed; the existing job continued, failed after its effect,
and its declared status probe established `applied` before HTTP replacement.
Live Docker events showed two migration Starts and one probe Start, with one
app-owned effect per release. Replay preserved plan identity and deadlines.
The app fixture uses an external HTTP ledger, not a SQL engine or retained
volume. Exact versions, reproduction and raw evidence locations are documented
in `test/lab/swarm-platform/README.md`. This targeted pass does not complete
normal fleet integration, worker/maintenance/data acceptance or the full
upgrade lab. An earlier run exposed health-probe CPU overhead and failed with
116 HTTP errors; that evidence remains recorded alongside the corrected fixture.

The coordinator publishes per-application plan image pins through
`kayra app deployment pins SERVER APP` and the operation catalog's API/UI/MCP
clients. Pins distinguish active, last-known-good, candidate, rollback and
unresolved plans; complete-plan and HTTP-workload identities stay distinct.
Missing or corrupt immutable descriptions refuse the whole snapshot. The
projection contains image digests and release identities without materialized
inputs. It explicitly sets `gcSafe: false`: build pins remain a separate
conservative export, live runtime attachments and legacy Compose history are
not inventoried, and legacy destructive registry GC remains refused on hosts
managing Swarm applications.

New experimental Swarm proposals also validate image metadata before accepting
workload intent. A runtime adapter reads only the existing private registry,
verifies immutable manifest/configuration digests and descriptor sizes, and
refuses inherited image volumes in this stateless integration. The composition
root calls its typed admission port after compiling both HTTP and complete
plans. It does not pull images or create Docker objects during preview. Reads
share one ten-second budget and one-MiB response bounds; redirects and descriptor
URLs are not followed, and configuration contents never enter public reports. Duplicate and case-aliased JSON keys, excessive nesting and excessive token counts are rejected before metadata interpretation to avoid parser differences.

Supported formats are OCI/Docker schema-two image manifests and an unambiguous
single-level index for the deployer platform (Linux ARM64/v8 or AMD64 without
extra platform features). Nested/ambiguous indexes and incompatible platforms
fail explicitly. These deliberately strict limits may be expanded with tested
capabilities later. Existing Compose behavior and already-accepted experimental
journal intents are not retroactively changed. Retained-dependency integration
will need declared, owned bindings for image volumes before allowing them.
The format checks follow the [OCI configuration](https://github.com/opencontainers/image-spec/blob/v1.1.1/config.md),
[manifest](https://github.com/opencontainers/image-spec/blob/v1.1.1/manifest.md)
and [image-index](https://github.com/opencontainers/image-spec/blob/v1.1.1/image-index.md)
specifications.

Current runtime health is a separate owner projection from release history.
The coordinator reads normalized adapter observations and considers only tasks
whose desired state is running, matched to owned deployment identities. A
healthy previous task can preserve availability during start-first overlap;
failed historical tasks do not mark the current application unhealthy. The
platform consumes a typed snapshot for its existing health endpoint instead
of interpreting journals or assuming a Compose backend. Observation failures
are reported explicitly. This first projection covers verified, registered
Swarm HTTP applications; worker, singleton, maintenance and removal health
semantics remain part of their integrations. Runtime availability does not
certify routed readiness or promote a candidate, and existing Compose health
behavior is preserved.

Global OOM, Docker-root or inode exhaustion, backup restoration, host loss and
multi-node behavior are outside this first single-node integration. Even a
passing integration is experimental and is not a universal zero-downtime or
data-safety guarantee.

### Managed Compose description groundwork

The managed description profile preserves logical named-volume mounts and
service dependencies, with canonical targets, explicit read-only/no-copy
semantics and started/healthy conditions. It rejects external volumes, driver
options, host binds, anonymous mounts, overlapping targets, missing dependencies
and cycles. Application declarations cannot choose physical allocation names.
The existing HTTP parser and compiler continue to reject the richer profile;
this parser alone does not enable volumes, dependency orchestration or workers.

Logical volume keys receive stable physical allocation identities through the
indexed coordinator writer. The full set is synchronized before any adapter
can receive an identity, and a lost acknowledgement reopens that exact set.
Concurrent reservations share the same key allocation. Omission from a later
request preserves the existing record; it does not authorize deletion or name
reuse. Allocation requires verified Swarm registration and an existing data
owner; old ownerless rows and Compose registrations cannot allocate these
identities. This is metadata intent, not proof that a volume was created or
resource admission. A future create receipt and missing-volume recovery policy
must be bound before enabling retained application workloads.

### Retained dependency input comparison

A retained dependency keeps its original input-generation references when its
immutable service declaration and bound input values remain unchanged. A new
registration or whole-configuration identity alone does not require replacing
that dependency. The platform resolves both exact generations and compares only
that service's declared bindings. Unrelated configuration or unused secret
rotation therefore does not force a database restart. A changed bound value or
binding is a dependency change and must be refused by ordinary first-integration
rollouts. Missing evidence is unavailable, never unchanged.

The coordinator's typed comparison port returns only `unchanged`, `changed` or
`unavailable`. Resolved values and private errors stay inside platform
materialization; no resolved secret values or secret-derived hashes are written
to deployment journals. Runtime materialization is a distinct port supplied by
the composition root. References are validated, bounded and scoped to the same
app incarnation. This comparison groundwork does not yet enable retained
services or their immutable-spec reconciliation.


### Immutable managed service specification

A managed service records exact image digest, role/overlap, health and shutdown
settings, budgets, dependency conditions, durable volume allocation identities,
private network identity, host affinity and service-specific input references.
Binding names, mounts and dependencies have deterministic ordering. It cannot
contain resolved environment values supplied by platform materialization.
Volume reference parsing alone is not evidence of creation: the coordinator
must synchronize creation receipts and verify actual ownership before effects.

The generated workload name includes the application incarnation in its digest;
recreated apps cannot target old name barriers or accept their late effects.
The private overlay is incarnation-scoped and distinct from the platform routing
overlay. Fleet admission budgets remain in the application/group authority,
outside the retained service's immutable specification, so changing unrelated
fleet policy cannot imply a database-engine update. Admission and current host
authority still gate every workload effect.

Retained reconciliation compares the complete canonical specification, then asks
the platform to compare its input bindings. Only unchanged evidence carries the
recorded specification and original input generation forward. Changed inputs or
specifications require a separate operation; unavailable evidence blocks the
rollout. This helper and parser do not enable richer runtime capabilities.

Managed image preview may accept inherited image volumes only when every exact,
canonical target is covered by a declared named mount. An ancestor or descendant
mount is insufficient. Preview inspects immutable registry metadata without
creating containers or volumes and does not certify physical ownership or data.
One-shot migration/probe usages still require images with no inherited volumes,
even when the same digest is permitted for a mounted long-running service.
The existing HTTP-only image-admission method keeps its no-volumes restriction.

### Volume creation evidence

A private volume-creation state machine records the owning app/data generation,
admitted deployment identity, exact allocation, stable action identity and
original absolute deadline before issuing an adapter call. Creation retries are
bounded and idempotent within that never-reused allocation. Unknown observations
cannot justify a create, and every attempt rechecks the parent's current fence,
allocation and admission authority through a typed port. The parent must provide
those checks; parsing or a lab's fixture authorization does not grant admission.

The controller synchronizes an observed creation receipt before reporting its
creation phase ready. A rejected journal acknowledgement poisons that writer
until reopen. A known volume that disappears or whose receipt conflicts is held;
the controller never repairs that condition by creating empty replacement data.
It never deletes volumes or starts workloads. A recorded creation receipt is
historical metadata, not current routed readiness or workload permission.

A separately bounded diagnostic inspection can observe the exact object after
creation authority expires. It cannot update the journal, unhold an operation,
refresh the original deadline or issue a native effect. Group reconciliation,
current volume checks, lifecycle fencing and indexed admission remain required
before this primitive can enable retained application workloads.

### Platform-owned private application overlay

Every richer Swarm application uses a platform-selected private overlay scoped
to its app incarnation. Apps keep the implicit Compose network and logical
service dependencies; they cannot choose host, shared routing or foreign app
networks. HTTP joins both its private overlay and the platform routing overlay;
workers, singletons and retained dependencies join only the private overlay.
Only HTTP specifications pin the routing-overlay ID. A retained dependency must
not acquire an immutable dependency on infrastructure it does not use.

Platform policy derives the overlay request from verified registration/runtime
and host authority references, and persists the action and resulting physical
grant before admitting workload plans. The runtime port validates single-node
manager identity, fixed overlay policy and exact ownership labels. Duplicate
matching names are ambiguous and block selection. The port has no network
prune/delete operation or workload orchestration.

An initial uncertain create is followed by observation rather than blind retry.
A stored grant pins its exact network ID: absence or replacement blocks ordinary
provisioning instead of silently recreating infrastructure for live workloads.
Initial registration now uses these interfaces with durable grant storage and
immutable publication. Lifecycle cleanup and managed workload admission remain
required before the richer workload capability can be enabled. They confer no app-selected infrastructure authority.

### Initial registration ownership read model

The platform can request `ctl registration ownership <app> <generation> <ticket>`
after the coordinator accepts that exact initial Swarm registration intent. The
read model binds the registration metadata to the indexed data-owner reference;
it remains identical after publication, acknowledgement loss and reopen. A
Compose registration, unsubmitted reservation, mismatched ticket/generation or
foreign scope cannot obtain this Swarm bootstrap reference. Old ownerless rows
remain unavailable rather than inventing a data owner.

The model contains no secrets, deployment state, private journal fields or
physical allocation grants. It does not authorize network/volume creation,
workloads or resource admission. The platform consumes the normal component
command/read model instead of reading deployment files. Existing reserve replies
remain unchanged, and the existing privileged process/control listener carries
this additional internal read. Platform publication validates and persists the
resulting infrastructure grant; richer-plan admission must independently verify
its ownership and current native evidence.

The initial Swarm host publisher now obtains this reference after submit and
writes `ownership.json` into the same immutable public generation before sealing
it and replacing the current pointer. The root observer validates its complete
scope and permissions. A publication retry requires the same owner; missing or
changed ownership cannot be acknowledged as that publication. Compose snapshots
retain their previous file set. Older snapshots remain readable, while the new
ownership reader explicitly refuses absent ownership rather than inferring it.
The reader uses the expected immutable registration generation and never follows
a newer current pointer. These references still confer no infrastructure or
resource admission authority. Physical overlay grants and managed workload
admission remain separate, pending integration work.

### Durable platform overlay allocations

Platform infrastructure allocations have their own synchronized records, separate
from deployment journals. The composition root supplies storage and native ports;
platform logic imports neither coordinator storage nor runtime implementation.
The internal `ctl platform app-overlay <app> <generation> <ticket>` command first
obtains the exact admitted ownership reference through the lifecycle interface.
It persists an operation identity and a 90-second absolute effect deadline before
any network creation. Operator host enablement and lifecycle authority are checked
again before the effect. One owner serializes concurrent requests and holds the
exclusive storage lock; uncertain writes require reopen before further effects.

Restart observes a possibly created overlay and preserves the original identity
and deadline. An expired intent may only acquire fresh read evidence, never a new
creation deadline. Recorded physical network IDs remain pinned: missing or
replaced networks block provisioning. This internal command runs in the existing
privileged process and creates no additional socket holder or listener. The initial Swarm registration publisher calls this platform command and
publishes its physical grant before registration reconciliation. This grants no
workload admission; lifecycle cleanup and managed-plan admission remain required
before enabling managed service groups.

The coordinator additionally publishes whether the scoped registration is still
initial or already verified. This permits initial platform storage provisioning
without treating a missing record for a registered application as a new grant.
Registered applications require existing allocation storage; absent storage is
an intervention condition, including older registrations that predate this path.
The platform obtains this state through a typed lifecycle read and never opens
private deployment records.


### Immutable registration infrastructure references

New initial Swarm registrations publish `infrastructure.json` alongside the owner
reference in their immutable public generation. The platform command supplies the
physical overlay ID; app inputs cannot supply it. Publication and retry validation
bind its app/incarnation scope and exact owner. The reader requires the expected
registration generation, strict root-owned files, matching owner publication and
the selected node/cluster. It refuses the shared routing network as a private
network. Older snapshots remain readable but cannot supply inferred grants. This
reference is metadata: admission still requires current lifecycle authority,
resource reservations and native observations. Compose publication is unchanged.


### Planned volumes and creation evidence

Managed service plans contain the data-owner/allocation identity, physical name
and mount policy before resource admission. A newly allocated volume has no
creation timestamp yet; its eventual native receipt must not mutate the plan or
its digest. Creation receipts instead belong to durable execution evidence.
Before a mounted workload effect, recorded receipts must match each planned
allocation and normalized native observations must match those exact receipts,
including creation timestamps. Missing, foreign, unavailable, duplicate, extra
or replaced instances fail validation. The caller must still establish fresh
observations under the current admission lease and lifecycle fence. Contract
matching alone grants no workload authority. Existing HTTP/one-shot plans are
unchanged; this managed-plan format is still unenabled and unpersisted.


### Immutable managed application proposals

The version-three managed proposal format joins the published registration and
private overlay, exact host/grants/hostnames, configuration identity, canonical
service specifications, ordered rollout declarations and normalized routes.
Compilation accepts operator-supplied capabilities and durable allocation IDs;
unsupported combinations, dependency cycles, conflicting volume identities,
missing image resolutions and out-of-grant steady workloads fail before any
runtime effect. Dependency validation removes ready graph layers, bounding dense
acyclic graphs rather than traversing every possible path. Candidate overlap and
one-shot reservations remain separate admission work, not a guarantee made by
proposal parsing.

Registry inspection can return both the immutable source reference and the
selected native manifest reference. Both digests are byte-verified through the
index/manifest/config chain, and all service and one-shot usage contexts are
validated independently. Selected references remain in the same app repository.
Changing source index attestations/provenance therefore need not change a
retained service's native image specification. Source provenance remains pinned
in the application proposal. Shape parsing does not establish this relationship;
the trusted read-only runtime adapter must supply it.

Image inspection contexts are derived from Compose mounts and migration targets.
A service's inherited-volume coverage cannot authorize using that same image for
a one-shot. Check commands target existing app containers and do not acquire
one-shot mount privileges. The compiler and format remain disconnected from the
normal admission/control path until managed execution, reconciliation and
recovery implement these declarations. Existing version-one HTTP and version-two
migration/HTTP plans retain their behavior.


Platform state is backed by its own private host directory and writable bind in
the existing deployer. Host setup provisions UID/GID 1000 and mode `0700`; the
builder has no mount. Composition synchronizes new allocation directory entries
before journaling effect intent. Container replacement must retain original
physical grants and deadlines, rather than relying on a writable container
layer. The upgrade fixture checks the actual host bind and container recreation.


### Native managed workload adapter

The managed Swarm adapter consumes a single canonical service specification and
persisted volume creation receipts. It reobserves the exact owned volume
instances before a workload write and before desired-state verification. Native
binds, driver options, privilege drift, extra mounts and unrelated ownership
cannot satisfy that verification. Materialized values and receipt inputs are
snapshotted before asynchronous observations and never returned in normalized
runtime observations.

Private DNS aliases use the logical service name in the incarnation-owned
overlay. Only HTTP services join the platform routing overlay, under generated
platform routing policy. Declared forbidden overlap maps to stop-first;
allowed/coordinated overlap maps to start-first with the fixed 30-second monitor.
Existing retained dependencies reject ordinary replacement through this adapter;
initial creation and lifecycle fencing/tombstoning are distinct operations.

Both HTTP and managed adapters share the runtime-internal owned-service primitive
for ownership checks, exact version CAS, bounded effects, observations and empty
name barriers. Public adapter ports accept validated plans, not arbitrary native
Docker specs. The coordinator still cannot import runtime implementation modules
or execute raw commands. This adapter remains disconnected from the normal
application rollout path until group admission, sequencing and recovery are
complete.

### Managed transition admission

Managed transition preparation now carries retained dependency specifications and
input-generation references forward unchanged. Recorded dependency baselines also
bind retries of a failed first rollout, even when no release has become verified
active. A missing dependency, changed engine/resource/mount specification, changed
used input or unavailable comparison evidence refuses preparation. Read-only input
comparison has one absolute, bounded preparation deadline.

The transition computes a conservative resource envelope for steady workloads,
retained startup, migration plus status-probe overlap, and candidate/previous/
restored-consumer overlap during recovery. It checks the application grant and
passes that envelope to the existing host resource book; the owning lifecycle
writer must synchronize the reservation before effects. Replaying the same
reservation reads its recorded result without extending its deadline or granting
fresh effect authority. Ordinary transitions cannot change host authority,
application ownership or the physical private overlay. A rolling transition must
retain permission to restore its previous routes.

This preparation/reservation seam is not yet connected to normal managed group
execution. It does not establish migration sequencing, release promotion,
compensation or cancellation guarantees for version-three plans. Group execution
remains disabled pending those integrations and their native acceptance tests.

### Managed migration sequence binding

A managed plan now derives a deterministic description for the existing durable
one-shot sequence owner. Each ordered step uses its declared app-image service's
selected native digest, entrypoint, resource limits, shutdown grace and input
bindings. Jobs receive only the incarnation's private application overlay; they
receive neither the platform routing network nor service volume mounts. The
existing stable operation identity, restart-disabled job adapter, status probes,
fencing and original retry deadlines remain in use.

Managed plan validation refuses migration commands, reserved operation-ID
bindings and other job descriptions that the one-shot contract cannot support.
Input reference selection checks the exact service image, bindings, private
network and migration/probe command before returning a reference to the platform
materializer. It returns no secret value and supplies no admission authority.
The parent still must establish the exact run, retained artifact, prerequisite
readiness/quiescence, lifecycle fence and synchronized reservation before effects.

A journal-reopen test binds a managed description to that existing sequence owner
and recovers a lost Start acknowledgement without duplicate execution or a new
deadline. This is component integration with a modeled Docker API, not native
multi-service rollout acceptance. Normal managed execution remains disabled.

### Group-owned service execution slots

A managed service execution slot now retains its exact canonical specification,
original deadline, stable effect identity and expected native version before
apply/restore dispatch. The group supplies a private journal view and typed
ports that check lifecycle/admission authority and materialize inputs in the
composition root. The slot records no resolved environment or routing values.
It grants neither admission nor active-release promotion.

An uncertain write is observed rather than dispatched again, including restart
between synchronized intent and actual dispatch. A missing runtime object is not
proof that the original create cannot arrive later; it waits within the original
window, then holds for group recovery/fencing. Journal acknowledgement uncertainty
poisons the live handle until reopen. Late authorization responses cannot trigger
writes, and healthy evidence observed after expiry cannot certify convergence.
Existing retained dependencies cannot acquire an ordinary replacement slot.

Native identity validation is shared by the adapter and coordinator. Role-neutral
service convergence checks are shared with the existing HTTP implementation;
routed readiness remains a separate HTTP requirement. Group sequencing,
compensation, cancellation and indexed ownership still must connect these slots
before normal managed execution can be enabled. These component tests do not
replace integrated crash-matrix or application-behavior acceptance.

### Group-owned quiescence and name barriers

A managed service barrier now owns durable zero-replica removal and subsequent
scrubbing under one original 90-second deadline. It retains exact service/image
identity, known native versions and each new CAS intent before dispatch. Draining
tasks prevent completion; both current and previous specifications must have no
inputs, mounts or network attachments, and the VIP must be released. Completion
requires a newer native revision than every supplied earlier effect revision.
The inert service name stays reserved, fencing delayed old creates. Volumes are
not deleted and this component cannot release admission charges.

Restart observes an unchanged uncertain CAS without dispatching it again. A
freshly observed revision may allow a distinct bounded recorded attempt; it is
never substituted into an earlier intent. After scrubbing begins, unexpected
application writes hold the operation. Missing recorded native identities,
foreign observations, expired authority and exhausted attempts also hold. The
lifecycle owner still must settle migrations/competing work and authorize which
services may quiesce; retaining a dependency during maintenance is its policy.

These slots are prerequisites for group cancellation, maintenance and removal.
They are not yet connected to indexed group execution or lifecycle completion.

### Retained dependency reactivation after quiescence

Cancelling an initial rollout may stop and scrub a retained dependency while
preserving its volume. A retry in the same incarnation therefore needs an
explicit reactivation effect. Ordinary retained replacement remains refused.
The separate adapter port requires the exact owned, scrubbed zero-replica barrier
revision, terminal tasks, no retained inputs/VIP, an unchanged canonical service
digest in the barrier, and fresh volume creation evidence. Any changed engine,
inputs, resource/mount configuration or physical revision refuses the effect.

The service slot persists an explicit reactivation mode and expected barrier
revision before dispatch; recovery observes it without replaying an uncertain
activation. Missing dependencies use initial creation, and consumers cannot use
reactivation mode. Composition must supply this capability and the lifecycle
owner must still authenticate admission and the retained baseline. Both ordinary
and reactivation writes snapshot the caller's exact CAS before asynchronous reads.
This port is a prerequisite for group cancellation/retry, not group admission or
normal execution enablement.

### Managed retained-startup and migration parent

One private preparation journal now composes retained-service execution slots
and the existing migration sequence owner. Retained dependencies start in their
healthy-dependency order. Recorded active baselines are freshly verified and
reused without replacement; recorded scrubbed baselines use explicit unchanged
reactivation. Missing known instances hold rather than creating empty data.
Migrations require healthy retained dependencies before Create/Start, and their
input materialization remains in trusted composition ports.

The parent retains the immutable group and sequence descriptions, snapshots
proposals before writer queuing, preserves startup/migration deadlines and child
intents across reopen, and opens one bounded consumer window after preparation.
That window is not active-release promotion or renewable effect authority.
Uncertain parent persistence poisons the handle. Runtime reads and dependency
verification are bounded. Normal admission must still authenticate the accepted
run and reserve the transition envelope under the lifecycle writer.

This rolling preparation phase currently refuses maintenance and coordinated
checks before intent; quiescence/check sequencing is subsequent integration.
Consumer updates, compensation, cancellation, indexed lifecycle ownership and
all public rollout paths remain work. The native group probe uses explicit
fixture authority and an app-owned HTTP ledger on a retained volume; it does not
establish SQL, admission, SIGKILL, worker delivery or release promotion guarantees.

### Platform-owned routing for managed service groups

Managed routing generates labels separately for each HTTP service; workers and
retained dependencies receive none. Router identities derive from incarnation,
host and path rather than route-list position, so adding a route does not rename
unrelated routers. Backend identities also bind the service and port. Existing
version-one HTTP label behavior remains in its compatibility implementation.

Transition validation treats routing-only changes as workload changes even when
the service specification digest is unchanged. A rolling transition refuses
moving an existing host/path between logical services: overlapping native
service definitions can conflict in Traefik. The app can declare maintenance,
subject to its fleet grant. This is runtime capability validation, not custom
traffic switching or an app-selected infrastructure backend.

Managed routed verification checks every route of the selected HTTP service,
using the shared platform HTTPS policy, trusted TLS/SNI, fresh connections and no
redirect following or retries. It does not accept another service's success in
place of a failing route. The observation uses the oldest completion timestamp
for freshness. These platform ports remain disconnected from normal managed
consumer rollout until group convergence, compensation and indexed ownership
are integrated; unit TLS evidence is not integrated Traefik continuity evidence.


### Connected managed lifecycle owner

A private managed V3 owner now composes admission, maintenance quiescence,
retained startup, migrations, consumer replacement and final application checks.
One synchronized app journal owns the child views. Its source fixes the run,
action, immutable candidate, verified previous release and absolute deadlines;
reopening cannot rebuild these from a branch or renew a phase window.

Final verification and active/last-good release promotion share one atomic
journal replacement. Resource settlement follows that replacement and can be
reconstructed after a lost acknowledgement. A retained release record binds the
complete native, routed and declared-check evidence; parsing a historical record
does not establish current health. Old child views remain bound to their run and
cannot write a subsequent operation. Cancellation can be recorded while native
work is in flight and prevents late verification from promoting a release.

This implementation covers successful rollouts. A failed or cancelled operation
holds its resource charge: it does not yet claim complete compensation, effect
fencing or safe removal. The normal managed V3 entrypoint remains disabled until
recovery, shared platform accounting, operator integration and native acceptance
are complete. The private admission port must use the existing global resource
book shared with other Swarm operations; an independent production accounting
book is prohibited. Migration services with volume mounts are currently rejected
before admission because the one-shot adapter does not support those mounts.


Managed admission accounting also has a pure binding projection for the shared
resource book. The exact owner/run/source/plan/action/deadline is committed with
its charge. A legacy charge with the same sequence cannot be adopted, expiry
does not renew a reservation, and stale run identities cannot settle a newer
operation. Legacy pending charges still consume capacity. These functions do
not authorize runtime effects or terminal outcomes; the indexed lifecycle owner
must authenticate those and synchronize both fields under its global writer.


### Managed migration resolution groundwork

The private managed lifecycle owner can resolve a held ambiguous migration
through the existing operator request and audit formats. Composition must
authenticate the actor and authorize the current run. The owner requires the
matching pending admission; resolution freshly observes every owned job fence
and validates the retained sequence and job descriptions before recording an
outcome. A missing or live fence cannot be replaced by an operator assertion.

The audit, original execution evidence, receipt and resume/hold decision share
one atomic parent replacement. Reopening or retrying returns the persisted
receipt without rerunning jobs, renewing deadlines or changing the decision.
An applied assertion resumes only within the original window. Not-applied and
late assertions stay held and retain capacity. No image or active-release
promotion follows from an assertion alone; normal convergence and final checks
still apply. Cancellation resolution, native cleanup, compatibility history
fences and the normal indexed/client dispatch remain subsequent work. The
managed V3 entrypoint is still disabled.


### Data compatibility history groundwork

The private managed lifecycle journal now records a compatibility epoch before
an app-declared rollback-unsafe candidate can start a migration, workload or
completion check. The synchronized intent advances once per operation, so a
lost acknowledgement or restart cannot erase the barrier or advance it again.
An ambiguous effect conservatively retains that barrier. No schema, SQL or queue
behavior is inferred by Kayra.

Verified active/last-good pointers carry the epoch in which they were verified.
Private historical restore selection is authenticated against the synchronized,
content-addressed journal history and must match the exact candidate plan and
current epoch. Removing the restore marker does not bypass the guard: after a
fence, known old plans are checked against the same history. A fresh build with
new declarations remains the application's compatibility responsibility. History
inspection has a fixed metadata deadline; missing or corrupt history refuses
admission before workload mutation. A stale active baseline also cannot admit a
rolling rollout. Forward recovery needs its own admitted lifecycle operation.

This uses private journal format 2. Pre-fence private V3 format 1 is refused;
compatibility safety is not invented for those isolated experimental records.
Legacy Compose and existing V1/V2 Swarm paths are unchanged. The epoch and
history must survive the future managed removal/recreation tombstone and be
respected by operator/client dispatch before normal V3 execution can be enabled.
There is no automatic down-migration, compatibility reset or production
conversion in this groundwork.


Managed run sources additionally require each active retained reference to come
from the verified previous release. Matching labels alone cannot bootstrap a
reference into a new root. Successful runs must carry the exact recorded
inactive dependency inventory into the next run; a reactivated dependency leaves
that inactive set only after its containing release is verified. Recovery and
removal must publish their own verified inactive inventory. This groundwork
rejects unrecorded adoption and inventory loss before new workload admission.


### Connected rolling recovery groundwork

The private owner now restores a compatible rolling application's complete
previous plan after a failed candidate, then runs that previous release's
checks with a distinct recovery identity. It commits the restored verified
active/last-good record before settling the pending reservation to the previous
budget. Requested candidate identity, original failure, recovery observations
and verified active release remain separate. A lost settlement acknowledgement
is reconstructed from the bound resource book without another workload update.

Recovery's 90-second deadline is persisted before the first child intent and
survives reopening. Every recovery effect requires the matching reservation,
current operator authority and fresh native migration-container fences. Recorded
fences alone are insufficient; stopped containers do not establish migration
outcomes. Every ambiguous migration needs its declared probe or audit outcome.
A possibly started unknown completion check prevents restoration until its
pinned container's cessation is established. Unsafe data epochs do not permit
this automatic rolling recovery.

Cancellation during recovery preserves its deadline and completes restoration
before reporting a terminal outcome. A later migration assertion cannot resume
a forward rollout that recovery has superseded. Dependencies introduced only by
the failed candidate are scrubbed without deleting their data; their exact
retirement barriers/specifications must be carried into subsequent operations.

The private journal format is now 3, with explicit deployment/recovery outcomes
and previous-budget settlement. Pre-outcome isolated V3 records are refused;
normal legacy paths are unaffected. Subsequent private owner capabilities are
described below. Unknown-check cleanup, removal/recreation tombstones, shared-index
binding, normal operator/client dispatch and integrated acceptance remain required.
Normal managed V3 execution is still disabled.


Recorded shared mounts remain valid when a failed new dependency is retired.
Another retained service may continue using that volume only when its logical
service and exact volume identity already occur in the verified previous plan
or authenticated retired inventory. Fresh ownership observations and unchanged
specification/input validation still apply. This preserves established sharing;
it does not authorize a renamed or new service to adopt retired data or bypass
engine-change refusal.


### Failed first-deployment cleanup groundwork

A failed first deployment with no verified previous release can now converge to
absence under its original admitted operation. The owner fences and scrubs all
owned candidate workloads, observes actual container cessation, retains named
volumes and dependency specifications, commits an explicit absent outcome and
only then settles capacity to absent. It does not invent or promote a previous
release. A stale cleanup certificate triggers fresh observation under the same
deadline rather than renewing authority.

This also permits cleanup after a known irreversible initial migration: going
to absence preserves data and the compatibility floor, with no image restoration
or down-migration. Unresolved migration outcomes and possibly started unknown
checks still hold. A later explicit deployment must carry the exact retirement
proofs and use the protected unchanged-dependency reactivation path. Missing data
is not replaced by an empty database.

### Unstarted settlement and compatible maintenance recovery

When no workload-effect intent exists, the root can now persist an unstarted
terminal intent before closing its admission identity. The global accounting
projection either preserves the exact old release budget or records absence;
it also fences a delayed reservation racing cancellation. This metadata-only
settlement can finish after the original deadline without granting another
execution window. The old verified pointer remains unchanged, and inactive
dependency inventory carries intact when a planned reactivation never ran.
Any preparation, consumer, check or nonempty maintenance effect intent excludes
this path. Expiry alone is never proof of workload cessation.

After preparation intent, a declared-compatible maintenance failure can restore
the previous application using the authenticated completed quiescence snapshot.
Recovery carries every recorded quiescence CAS version, preserves its original
90-second deadline, verifies the restored application and then settles its
previous budget. The application must understand the resulting schema; Kayra
performs no down-migration. Unsafe compatibility epochs and unknown outcomes
continue to require forward recovery or intervention. Maintenance downtime is
expected and must be measured separately from rolling continuity.

For declared-compatible maintenance cancelled during partial quiescence, the
same recovery pipeline now uses the recorded stop intents and verified previous
dependency references. The preparation and migration evidence remain absent;
only old consumers are restored. Candidate-only services cannot be created or
invented as retired dependencies by this path. Restoring a newer native version
fences a delayed stop that races recovery. Unsafe pre-preparation recovery and
audited unknown-check cleanup, removal/recreation and normal index/client
integration remain subsequent work. Managed V3 stays disabled.


### Shared lifecycle gate integration

Managed V3 now has reference-only requests in the existing lifecycle envelope.
Ticket admission, source identity and action allocation are synchronized in one
replacement. Registration work cannot claim another action while that deployment
owns the gate. The generic envelope writer delegates managed decisions to pure
transitions; it does not gain Docker access or rollout policy.

A matching settled root snapshot, retained under its content digest, is required
before completing the ticket and releasing the gate. Root snapshots and verified
release records have distinct references. Lost admission/completion replies replay
the recorded request, and legacy HTTP/rollout history cannot be silently adopted.

If the process dies after acceptance but before the root journal exists, separate
current metadata authority can reconstruct a held, effect-free root from the
accepted immutable source. Expired scheduling deadlines and revoked workload
grants do not become fresh authority. Existing roots are never reset by this path.
The platform-wide index/protocol binding is described below. Normal client
dispatch remains pending; these envelope methods alone are not a production
entrypoint.


### Indexed managed ownership and admission

The internal app index now persists an explicit `managed-v3` protocol for new
experimental applications. Existing entries retain their implementation;
conversion is refused. Legacy deployment commands and restart queues cannot
interpret a managed application's records. Registration, data-identity and
build operations use the common indexed ownership boundary.

Managed reservations use the existing global book and writer alongside legacy
charges. Owner, retained build receipt, immutable source, shared ticket/action,
root state and admission binding are revalidated before mutation. Current
operator permission and normalized host observations are required for admission.
Source/history/capability preflight happens before issuing a lifecycle ticket.
The index records known root initialization; a missing initialized root is an
intervention condition, never permission to create an empty replacement journal.

Metadata-only unstarted settlement revalidates its effect-free proof and closes
late reservation races even when capacity is unavailable. Foreign source bindings
remain charged and cannot be adopted by matching their numeric sequence. Completed
migration assertions replay their retained audit snapshot, including after a newer
run, with current operator authorization and no repeat job.

Normal managed registration/control dispatch is still disabled. Until its managed
health projection is integrated, the legacy host-health path explicitly refuses a
host containing these internal protocol records. Normal builder/platform wiring,
operator projections, removal/purge, unknown-check cleanup, unsafe forward recovery
and the complete integrated acceptance matrix remain required.

### Managed deployment status projection

The deployment owner publishes a separate validated Managed V3 status contract.
Requested and desired plans, verified active and last known good releases, the
data compatibility epoch, rollback eligibility, original deadlines, migration
step/reason and audited resolution references are distinct fields. A held operation
requires inspection and resolution. A cancelled unstarted replacement retains
the previous verified release without attributing it to the newer run.

The projection validates immutable source bindings and reads certified release
records by digest, checking ownership, plan, run and verification time. Missing
or corrupt evidence refuses the projection. Reading status performs no workload
observation or release promotion; `runtimeObservation: not-observed` is explicit.
It exposes no private journal paths, resolved environment or command payloads.
This internal index method does not yet enable normal managed registration or
client dispatch; runtime health and client integration remain separate work.

### Managed runtime health projection

The deployment owner can publish the existing runtime-services health contract
for managed apps. It validates source and certified release evidence, then makes
fresh owned service/specification observations. Current desired tasks determine
availability; historical failed tasks are counted separately. Task action/plan
identity, recorded native IDs and versions, actual container convergence and
paused updates are checked. Missing or foreign workloads cannot appear healthy.

During replacement the observation can recognize recorded previous and candidate
workload intents. Terminal recovery observes the verified effective release,
excluding retired candidate-only services. A healthy candidate whose app check
failed may still be available while status identifies the held deployment and
previous verified active release. Availability neither certifies a new release
nor establishes routed readiness. The host snapshot requires explicit managed
observation ports and refuses their absence; normal managed dispatch stays off.

### Managed deployment image pins

The deployment owner publishes immutable application-plan and bundle identities
with active, last-known-good, candidate, rollback and unresolved roles. It also
exports images from retained retirement specifications so that scrubbed native
workloads do not erase the last coordinator reference. Candidate images remain
pinned after failure/cancellation as a conservative description of potentially
retained native history.

Status, health and pins share source/release evidence validation. Pin reads have
no runtime effects or resolved inputs. They explicitly report `gcSafe: false`
and `attachments: not-observed`; they are input for a later pin-aware collector,
not permission to collect. Legacy destructive registry GC remains refused while
coordinator-managed ownership records exist. Historical retention policy, live
attachments, unresolved runtime references and platform image pins still require
separate reconciliation before any collector can safely delete images.

### Reporting capabilities and interrupted acceptance

Published managed status and image pins require only an artifact reader and
clock. Runtime health adds only owned service/specification observation ports.
The reporting path holds the application's journal ownership but does not
instantiate the execution coordinator, authorize workloads, initialize operation
state, settle admission or synchronize release promotion. Execution ports remain
inside lifecycle composition.

A registered app with no accepted deployment returns no managed deployment
projection and creates no root journal. An accepted request whose root is missing,
or a newer accepted request whose root still describes its predecessor, refuses
reporting until lifecycle reconciliation reconstructs the operation. Reports do
not silently present the predecessor as the latest request. Existing initialized
journals are opened strictly; missing records are never replaced by a reader.

### Published query compatibility

The existing authenticated deployment status, health and image-pin queries select
the reporting implementation from the indexed ownership protocol. They do not
infer a backend from Docker observations or enable deployment mutations. Managed
reports use the shared versioned contracts; an application with no accepted
deployment returns null. Non-null responses retain the existing application-scope
check in the wire client. Managed health requires explicit managed read-only
observation ports and refuses substitution of legacy observations.

CLI/API/MCP share the regenerated query contracts. The web deployment view shows
managed strategy, phase, requested/desired/certified releases, rollback eligibility,
migration step and current health separately. It omits legacy mutation controls
for managed reports. Normal managed registration/deployment compilation, mutation
operations, health composition and complete integrated acceptance remain pending.

### Managed workload input composition

A trusted composition factory connects managed workload ports to platform input
materialization, platform-generated routing and a read-only recorded-volume
receipt provider. It validates application/service/action membership before
private reads, checks current permission both before and after materialization,
and passes resolved values only to the native adapter. Failed private reads,
missing receipts or changed permission refuse the call without exposing values.
The native adapter retains independent ownership, full-specification, deadline
and fresh volume-creation checks.

Health can construct only the observation facade from native read ports; it does
not receive an apply, reactivation, fence or tombstone method. The factory does
not create or infer volumes. A deployment-owned receipt catalog and ordinary
platform policy wiring are still required before normal managed execution can
be enabled. The native singleton fixture supplies its explicitly recorded
creation receipt and fixture permission callback to exercise this composition.

### Recovering a volume creation receipt

An uncertain volume creation may leave a known allocation present without its
creation-time receipt having been synchronized. A separate metadata-authorized
command can inspect that attempted allocation and record its creation time. The
original attempt remains held with its original action, deadline and reason;
metadata observation does not become a successful rollout or new creation grant.

Recovery requires a prior attempted creation, a bounded observation, current
metadata permission before observation and before persistence, and matching
ownership. Unattempted, unauthorized or disputed allocations are not adopted.
The creation timestamp cannot precede the original intent (allowing Docker's
whole-second timestamp precision). Once recorded, later observations must match
that creation time; absence or a replacement is never permission to recreate.
Replay after lost journal acknowledgements retains the same receipt and original
creation deadline. The deployment-owned receipt catalog and normal lifecycle
wiring remain separate work.

### Recorded creation evidence as a runtime input

The deployment owner publishes a read-only volume receipt port from registered
allocation identities and validated creator records. Only a persisted original
receipt or separately recovered creation receipt supplies the birth time. A raw
native observation, unresolved attempt, foreign creator or unknown allocation
cannot mint that evidence; mixed requests fail without a partial receipt set.

The projection exposes no creator action, journal layout or mutable lifecycle
state to platform input materialization. A recorded receipt remains a historical
identity even when its volume is missing: the native adapter must independently
verify current ownership and creation time before use. The native singleton
fixture now creates through the durable creator and reopens its journal across
rollout recovery before consuming this read port. Its volume creation still uses
explicit fixture authority before indexed workload admission; ordinary admitted
allocation and receipt-catalog lifecycle wiring remain pending.

### Allocation catalog and immutable volume births

The deployment owner now has a single-writer allocation catalog. Registration
is append-only: a logical volume key and allocation identity cannot be rebound.
Each explicit creation operation retains its original deployment identity,
intent time, deadline and creation evidence. Replaying that operation cannot
renew its deadline. A later explicitly authorized operation may retry an absent,
never-recorded allocation only after the old window expires and a bounded
observation settles its current absence. An uncertain existing creation must
first be observed and sealed under current metadata authority.

Once any operation records a birth, every operation for that allocation uses
that historical receipt. Missing or replaced storage requires recovery rather
than another Create. Contradictory births and foreign ownership are refused.
The catalog supplies only the read-only receipt port to workload input
materialization; the runtime still independently verifies physical ownership
and birth. Histories are bounded and exhaustion holds for operator action.

The native fixture reopens this catalog alongside its application index and
counts Create calls across replacement, rollback and cancellation. Creation
still uses explicit fixture authority before indexed workload admission. The
normal coordinator's admitted allocation phase, removal retention and explicit
cross-incarnation delegation remain integration work; this catalog does not
establish those guarantees by itself.

### Admitted volume preparation phase

Private lifecycle source version 2 explicitly adds allocation after admission and
before maintenance quiescence, retained startup or application jobs. Existing
version 1 sources retain their exact normalized representation and deadlines;
reading them does not infer newly admitted storage preparation. Version 2 adds
one 90-second window to the total run deadline. Entry time, original allocation
deadline and completion time are durable root state, and `allocating` is a
published phase. Missing preparation capability fails preflight.

A typed preparation port reconciles the exact registered volume identities with
the deployment-owned catalog. It uses the run UUID for each stable allocation
operation and the immutable application plan digest. Every registration,
creation and recovery observation checks fresh parent permission, including the
shared admission lease and operator grants. A permission response arriving after
cancellation cannot grant creation authority. The port revokes its callback
scope when reconciliation returns. The original deadline and fresh parent
permission also bound work that outlives an observer wait. No service or migration starts before preparation reports
ready. A lost Create acknowledgement is reconstructed from the original catalog
intent, not a new operation or deadline.

Cancellation or expiry before any workload intent can settle CPU/memory
accounting without deleting empty allocations. This is not proof of zero native
effects: allocation intents and historical receipts remain in the separate
catalog. Removal and purge must retain and consult that inventory, including
uncertain creations. Disk reclamation is never implied by resource settlement.
The native fixture owns the catalog journal and current build/grant inputs;
normal platform catalog storage, tombstones and public dispatch remain pending.

### Index-owned catalog storage and input capability

New managed applications now initialize an empty, owner-bound catalog under the
existing deployment index before becoming ready. A persisted capability marker
records this ownership. Interrupted initialization resumes its original catalog;
a ready application's missing catalog is an intervention condition. Historical
managed records without the marker remain readable and cannot silently adopt
catalog-backed storage.

The existing app writer opens the catalog, binds preparation to the root owner,
and supplies its read-only receipt port to a workload factory. That factory
materializes private inputs without recursively acquiring the application writer.
New catalog-backed requests require private source version 2. Supplying an
independent preparation controller alongside this capability is refused.
External read models may obtain recorded receipts through the deployment
component; they do not open private files or acquire mutation capability. The
receipt reader validates registered scope before storage access and never holds
the global accounting queue while waiting for the catalog lock.

This moves journal ownership out of the native fixture. Public builder-to-plan
compilation, current platform grant/input wiring, lifecycle removal and guarded
purge remain separate acceptance work. The normal experimental mutation entrypoint
remains disabled.

### Observer reconstruction and input loading

The deployment index publishes a validated, immutable execution context from the
accepted request and its content-addressed source. It contains normalized plan
references and original identities/deadlines, without exposing the private root
journal layout or resolved secret values. Producing context does not initialize,
repair or promote a root and does not grant effects. Completed requests need no
new runtime context. A missing or changed source refuses reconstruction.

The optional managed observer in the existing composition root enumerates
pending operations, loads context, then binds per-run runtime inputs before
entering the application writer. A factory must not re-enter the index from a
job or service callback. Runtime-input loading has a bounded wait; a late result
cannot dispatch a tick. One unavailable application does not prevent others from
being reconciled. Observer restart uses the accepted plan and original deadlines,
never a fresh branch resolution or scheduling window.

The native singleton can stop its manual observer after the lost Create
acknowledgement and continue through a newly constructed managed observer. This
is observer reconstruction within the lab process, not a claim of full public
pipeline integration or coordinator SIGKILL acceptance. Wiring the factory to
normal current platform grants, private input generations and job materialization
remains required before enabling ordinary mutation dispatch.

### Per-run migration input composition

The job composition boundary binds the validated execution context before the
app writer runs. It checks run ownership, declared migration/probe commands,
image, resources, network and input references before private materialization.
Create resolves current platform inputs, rechecks permission and the original
scheduling window, then passes values directly to the native adapter. Permission and materialization
waits are bounded to ten seconds within the original scheduling window; late
responses cannot dispatch Create. Values and
private errors never enter deployment records or reporting. Start never resolves
a fresh environment and never adds retries. A lost native Create acknowledgement
remains uncertain and is observed through its stable runtime identity.

Observation and fencing have distinct current cleanup permission, so revoking
creation or startup need not strand an owned job. Existing native cleanup
deadlines remain binding; this port cannot mint another cleanup window. This
grants no applied/not-applied
migration outcome; the existing sequence owner still authenticates intent,
admission, deadlines and recovery semantics. The native maintenance fixtures bind
this composition when opening or recovering each source. Their grants and input
snapshots remain fixture callbacks; normal platform factory wiring is pending.

### Trusted managed-runtime assembly

A single composition factory now assembles the coordinator-facing workload, job,
check, readiness, host-observation and catalog capabilities. It accepts typed
adapters and platform input/authority ports in the existing privileged process.
Construction performs no runtime effects or private reads. Candidate and previous
plans remain immutable; another accepted source, action sequence or application
cannot borrow this instance's authority or private materialization.

Platform permission requests use shared contracts rather than private root or
job journal structures. The factory maps coordinator effect requests into these
permissions and separately authorizes private service/job inputs and cleanup.
Admission and durable intent checks remain with the coordinator and index. The
factory supplies the index's workload callback with its already-owned receipt
port; external health views use the deployment component's published reader.
Authority and private-input waits are bounded and private errors stay internal.

The singleton fixture constructs this factory from preloaded context, including
when reconstructing its observer. Fixture build, grant and configuration callbacks
remain explicit. The factory alone does not wire normal registration/deployment
commands, establish safe unknown-Exec rollback or complete lifecycle removal.

### Current platform permissions and explicit cleanup purpose

The platform permission provider verifies the app namespace claim and exact
immutable registration ownership before granting any operation. Creation,
startup, verification and private-input access additionally require the current
registration pointer, Swarm host profile, infrastructure grant, configuration
identity, resource grants, hostname/secret grants and migration policy. A stale
source cannot borrow a newer generation or silently fall back when publications
are missing. Policy reads resolve no secret values and never open deployment
journals.

Owned cleanup and audited metadata recovery can remain available when current
startup grants are unavailable. Service effects carry an explicit purpose from
the coordinator: deployment or cleanup. Quiescence and stop-first replacement
are deployment effects and still require current rollout permission. Recovery
fencing/stopping is cleanup; restoring or applying an image still requires
current startup permission. The platform does not infer purpose from private
phase files or application behavior. Native ownership/CAS checks and original
cleanup deadlines remain independently required.

The platform-input lab checks the filesystem provider as UID 1000 against
synthetic root-owned immutable publications. It covers stale current pointers,
changed data ownership/host metadata, unreadable publications, missing namespace
permission and cleanup without startup permission. Its synthetic host, overlay
and image references prove metadata policy only, not live runtime existence or
admission. Normal platform controller/control wiring remains subsequent work.

### Compatibility fences survive proposal metadata changes

After an incompatible operation advances the data epoch, ordinary deployment
must not revive a commit known only from an older epoch by changing artifact or
configuration metadata to obtain a new plan digest. The owning lifecycle writer
now authenticates historical release records and checks their source commits as
well as plan identity. An exact verified plan from the current epoch remains
eligible; explicit restores still require their exact authenticated record.

A metadata change does not establish forward schema compatibility for an old
commit. Such a request is refused before admission and requires a new app release
or an explicitly supported audited forward-recovery path. History inspection
retains its existing bounded metadata deadline. Unavailable/corrupt evidence
never grants permission, and no database state is inferred from commit identity.

### Deployment-owned proposal construction

The owning coordinator can now construct a proposal from a validated candidate
and its own verified release/history evidence. It derives the previous release,
active retained dependencies, and inactive dependency barriers from recorded
successful, recovered or unstarted outcomes. Platform code supplies immutable
candidate data and an input-comparison port, not private root records or claimed
native baselines. Retained specifications are normalized through the existing
transition checks, including unchanged private inputs and resource envelopes.

Proposal construction has no writer, native or admission port. It cannot reserve
capacity, create volumes, start jobs or promote a release. The owning lifecycle
writer validates the result again before acceptance; indexed acceptance must
still bind the exact build receipt, registered volumes, action and current grants.
Replaying an existing request returns its original source and deadlines; another
request cannot displace an unresolved operation. New proposals default to private
source version 2; version 1 remains an explicit internal compatibility path for
older fixtures and does not acquire the new allocation guarantees.

Normal builder/compiler/control orchestration remains subsequent integration.
The native maintenance and dependency-reactivation probes use owner-built
proposals while retaining explicit fixture input/accounting policy.

The app index now binds proposal construction to its verified registration,
registered volume identities and exact immutable build receipt. It selects the
next action from the existing lifecycle fence and loads completed root evidence
under the app writer. A new app's proposal does not initialize its root journal;
an established root is opened strictly as existing. The normal proposal path
refuses private allocation-protocol conversion rather than adopting pre-existing
storage. Replays return their accepted source, and acceptance still revalidates
scope, capability, history and admission independently.

#### Immutable managed request preparation

The deployment owner connects exact-commit build preparation, logical volume
identity reservation, platform compilation and source-v2 acceptance through typed
ports. An accepted run identity is looked up before building or compiling again;
its original source and absolute deadlines survive lost acknowledgements. A
completed retry returns its recorded receipt without composing runtime effects.
Pending retries reconstruct runtime inputs from the owner's shared execution
context. Compiler and runtime-factory waits are bounded to ten seconds; a late
factory result cannot accept an operation. Acceptance independently checks the
current registration, immutable build receipt and registered volumes.

The native singleton fixture exercises this internal preparation path with a
fixture compiler. The platform compiler adapter now reads exact immutable publications, validates
bundle hashes and builder contracts, derives supported Compose descriptions and
resolves registry image metadata separately for services and jobs. It opens no
secret files. Normal public mutation dispatch remains integration work; this does not enable managed deployments for existing
apps or convert their runtime.
