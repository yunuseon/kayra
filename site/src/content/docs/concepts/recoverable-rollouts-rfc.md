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

## Contracts and admission

A registration carries its selected runtime and grants. The managed app
persists that selection, and ordinary deployment cannot change it. Experimental
hosts and workloads declare finite CPU and memory budgets. Serialized
admission accounts for the active workloads, candidate overlap, one-shot jobs
and platform overhead; it reserves the budget before effects. A reservation is
not proof that Docker can schedule a task: actions also have finite deadlines.

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

Legacy filename-based destructive registry GC is refused on hosts managing
Swarm apps until GC understands image pins. The coordinator exports pins for
active, candidate, rollback and unresolved operations. Historical failed Swarm
tasks are not themselves evidence that the current application is unhealthy.

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
