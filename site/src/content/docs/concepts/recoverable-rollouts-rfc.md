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
This phase library enables no app capability by itself. Real-deployer admission,
parent lifecycle integration, maintenance and operator resolution remain
subsequent delivery work.

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
update/recovery. This format prepares parent lifecycle integration; it is not
itself an admission grant or an enabled app capability.

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

The current builder emits image tags and the existing deployment-plan contract
is only a fragment. Before using a plan to authorize effects, the coordinator
needs a reconstructible normalized description and trusted authorities for
image digests, registration and grant generations, secret-generation
references, and volume ownership. The HTTP candidate and Swarm service
renderer under development are disconnected experiments; neither establishes
those authorities or authorizes a live deployment.

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

Global OOM, Docker-root or inode exhaustion, backup restoration, host loss and
multi-node behavior are outside this first single-node integration. Even a
passing integration is experimental and is not a universal zero-downtime or
data-safety guarantee.
