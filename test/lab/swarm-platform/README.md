# Explicit Swarm host setup lab

Run the full upgrade scenario on a fresh disposable Multipass VM:

```bash
bash test/lab/upgrade.sh --from 0.23.0 --swarm-host --indexed-registration \
  --vm-name kayra-swarm-platform-unique
```

`--swarm-host` adds the fleet's explicit `experimental_swarm` profile after the
normal Compose upgrade, rollback, GC and polling checks. It verifies check mode
leaves Swarm inactive, then provisions one manager and an owned attachable
overlay through the platform role. A second reconciliation must report no
change. Existing Swarms and unrelated networks are refused; owned cluster and
network identities are recorded before publication. Interrupted acknowledgements
are reconciled without reinitializing a cluster. Host profile changes or removal
of this setting after setup require a future explicit maintenance/retirement
operation; setup never leaves a Swarm or recreates lost owned infrastructure.

Traefik keeps its Compose provider and gains the Swarm provider at the normal
refresh interval. The socket proxy adds SERVICES, TASKS, NETWORKS and NODES read
endpoints; POST remains disabled. No new service holds the Docker socket.

The probe creates one disposable, budgeted HTTP fixture through Docker directly,
using an existing fixture image by digest. It publishes no application port and
uses service VIP discovery. It verifies both Compose and Swarm routes with real
TLS, tests discovery GETs and denied POST/DELETE requests, removes its successful
fixture and records exact OS, Engine, CLI, Compose and pinned image versions.
This proves platform connectivity only. It does not exercise the coordinator's
application adapter, admission or a rollout, and does not establish continuity.

The machine-readable result survives successful VM cleanup at
`/tmp/kayra-swarm-platform-<vm-name>.json`. The upgrade script preserves failed
VMs and prints their fleet and cleanup command; `--keep` also retains successful
VMs. A failed probe leaves `kayra-lab-platform-http` for inspection, with
`io.kayra.lab=swarm-platform` and the owned node ID labels. Removing the disposable
VM cleans up that fixture as well.

The native API probe checks additional lifecycle prerequisites using the same
Unix-socket transport intended for the existing deployer process. A metadata-only
service update advances Docker's version without replacing tasks; a write using
the older version is refused. Docker 29.9.3 returned HTTP 500 with an
out-of-sequence error, so a non-success status alone cannot classify an outcome.

The probe then scales its fixture to zero, clears container environment and
network attachments, and uses DNSRR without a VIP. The service name stays
reserved, so a delayed duplicate create is refused. Recreating the fixture by a
versioned update keeps its service ID; a stale versioned removal is refused.
This tests a proposed native ownership tombstone, not an integrated Kayra removal
command. The probe deletes its successful disposable fixture after every API
request is acknowledged; failed fixtures are preserved and print cleanup IDs.
Results are saved beside the routing report with `.native.json` appended.

The native adapter probe additionally creates a unique, never-registered HTTP
fixture through Kayra's typed adapter. It verifies TLS routing, unchanged tasks
after a metadata fence, completed start-first replacement, stale-version refusal,
a zero-replica tombstone, a second fenced scrub of Docker
`PreviousSpec`, exact desired-spec verification and recreation on the same service ID. It uses
the existing deployer process/image and socket, with public lab CA material only.
The result is written beside the report as `.adapter.json`. Successful disposable
services are removed; failures print their service identity and cleanup command.
This proves adapter behavior, not coordinator recovery or HTTP continuity under
load. No registered application is changed by this probe.

Effect-step coverage keeps the same logical removal action across `remove` and
`scrub`, and proves that a zero-replica reservation rejects a delayed first-create
RPC. Desired verification recognizes a restored task template even when Swarm
retains newer service-level action metadata; routing and actual task inputs must
still match exactly. These checks remain isolated prerequisites for lifecycle
integration.

The platform probe builds the existing deployer image with the explicit
`KAYRA_REGISTRATION_LAB=true` dependency flag before running contract-aware
adapter checks. It recreates only that existing service, with no registration
control environment or extra socket holder. This makes the probe independent
of the later indexed-registration phase. The initial full upgrade exposed this
missing prerequisite after all legacy deployment checks had passed. Public
fixture files are readable by the existing unprivileged deployer user after
`docker compose cp`; they contain declarations, not materialized secrets.

`http-coordinator.yml` copies a frozen source tree into a disposable host directory
and uses the existing deployer image's Node runtime and contract dependencies.
It runs `http-coordinator.mjs` against the real engine/router, promotes A, kills
the writer immediately after B's update acknowledgement, then reopens the journal
and verifies B without another update. The report records the original deadline,
service identity and settled accounting. Successful sources and fixtures are
removed; failures retain their source/journal paths and print cleanup commands.

This component test supplies trusted fixture build/registration inputs. It is
not the full builder/platform integration or a request-continuity measurement.
The upgrade lab invokes it after the adapter prerequisites are ready and saves
its report as `/tmp/kayra-swarm-platform-<vm>.coordinator.json`.

`http-inputs.mjs <app> <full-commit> [preview-json-file]` is a read-only check of
platform materialization against an existing indexed fixture generation. A
preview file permits running it as UID 1000 without Docker CLI access. It reports
binding names only and checks that altered configuration identity and ungranted
secret references are refused. No materialized values are printed.

The coordinator component also deploys a candidate that exits after becoming
healthy inside Swarm's monitoring window, verifies the native rollback to the
previous release, and retains its recovery trace and elapsed time. It injects
a delayed candidate write and proves that a metadata revision fence rejects it
before the unchanged previous release can be settled. This still measures no
request continuity or automatic recovery of the existing release UI.

A component run on 2026-11-12 with Engine 29.9.3 / API 1.56 verified native
rollback in 41.9 seconds from update preparation, then rejected the injected
delayed candidate after fencing. This is elapsed recovery time, not an outage
measurement. Results: `/tmp/kayra-http-recovery-fixed.json`; command log:
`/tmp/kayra-http-recovery-fixed.log`. Reproduce with the component playbook:

```bash
PYTHONDONTWRITEBYTECODE=1 ANSIBLE_CONFIG="$PWD/ansible/ansible.cfg" \
  ansible-playbook -i <isolated-lab-inventory> \
  test/lab/swarm-platform/http-coordinator.yml \
  -e kayra_root=<frozen-checkout> -e report_path=<local-result.json>
```

The first fixture attempt was refused for an unresolved `$` argument before its
failure candidate was admitted; its previously healthy disposable service and
journals remain in the failed lab for inspection. Successful replay fixtures
were removed. The lab VM itself was already retained from an earlier failure.

Restart reconstruction now discovers the interrupted request through the
coordinator's owner-only work list and runs the scheduling-round interface.
After native rollback, the lab checks the public status contract: the rejected
candidate stays requested, the previous plan is desired and certified active,
and no fresh runtime observation is inferred from that certificate.

The restart replay now starts the existing process's HTTP controller and waits
for the durable outcome, without manually ticking the operation. The controller
discovers work from the index, preserves native CAS intent and deadlines, and
reconstructs the acknowledged candidate with zero repeated updates. It is also
wired into the optional indexed deployer composition when Swarm authority and
public/private registration inputs are present. This enables restart recovery
for durable internal operations, not ordinary Swarm deployment requests.

`http-control.yml` submits the registered fixture's retained build through the
existing deployer's loopback lifecycle interface, observes automatic promotion
and retries the same UUID without changing the deadline. It stores the request
before contacting the daemon, so interrupted lab reruns reuse its identity. The
explicit Swarm registration lab mounts only the public CA through
`NODE_EXTRA_CA_CERTS`; no router key or TLS directory enters the deployer.

The first real control run passed on 2026-11-12. Results and commands are in
`/tmp/kayra-http-control-live.json` and `/tmp/kayra-http-control-live.log`. The
fixture remains a managed Swarm application in the preserved failed lab VM; its
removal must go through the upcoming lifecycle owner. This run establishes
initial promotion and receipt replay, not continuity under load. The full
upgrade lab invokes it when both Swarm and indexed registration are requested
and retains `/tmp/kayra-swarm-platform-<vm>.control.json` after successful cleanup.

## Real-deployer continuity matrix

`http-fixture/` is an application-owned Node service with release/task identity,
readiness delay, permanent readiness failure, a post-health crash and graceful
20-second responses. Its 20-second health start period admits the 15-second
readiness case without killing preparation early. Resource limits, health,
shutdown and rollout declarations remain in the fixture's app/Compose files.

`prepare-http-fixture.mjs <new-source> <new-bare-repo> <lab-git-url> <manifest>`
creates seven immutable commits and 18 stable reset/update request pairs. Do
not reuse those request IDs for another measurement. `http-load.yml` registers
the fixture through the platform caller, enables JSON access evidence on the
existing lab router before measurement, and stages a temporary observer. It
changes no discovery interval and adds no retry middleware or socket service.
The router configuration is preserved before the lab-only logging change.

Run the staged `node http-load.mjs <manifest> <new-prepare-dir> prepare` to build
and retain every case before load. Run the same driver with a new results
directory and `run` to measure a 30-second baseline, then three repeats of each
HTTP case through the real deployer's lifecycle interface. All workload writes
go through that interface. Read-only runtime observations, task/health events,
app logs, filtered Traefik access logs and VM CPU/memory samples are retained.
Fresh and persistent TLS connections split 20 short requests/s with absolute
two-second deadlines and no client retry. Requests continue for 30 seconds
after convergence. The interruption case kills/restarts the existing deployer
container after native acknowledgement while traffic and Swarm continue.

The load generator uses absolute scheduled starts; a relative timer drifted to
356 requests in a 30-second baseline on the VM and that run was rejected before
any measured replacement. Every request succeeded in that invalid baseline; it
is not counted as continuity evidence. Its raw evidence is preserved at
`/tmp/kayra-http-baseline-invalid/`, with analysis explicitly marked incomplete.
The corrected run's baseline sent 601 successful requests in 30 seconds.

`analyze-http.mjs <results-dir>` independently reads per-request records and
health/crash evidence and writes `analysis.json` and `REPORT.md`. It reports
failed requests by connection class, cadence, premature exposure, sampled
failure windows and VM resource peaks. A post-readiness crash is disruptive
automatic recovery, never an uninterrupted-rollback claim. A held operation,
collector failure or bad cadence preserves the run rather than silently
starting a replacement experiment. Successful managed fixtures remain owned
by the coordinator until its removal interface is available.

The completed real-deployer matrix passed 18/18 cases; see [HTTP-RESULTS.md](HTTP-RESULTS.md) for exact versions, failed-request counts, disruption and resource evidence. This does not complete experimental Swarm integration.

The coordinator component also cancels a dispatched candidate, reopens its
journal after native restoration acknowledgement, and reconstructs cancellation
without repeating the restore. It verifies the original recovery deadline and
settles capacity to the previous plan. `recovery-overlap.mjs` independently
creates a disposable service with delayed termination and observes draining A,
B and restored A concurrently. The observed peak is three containers; admission
now reserves that recovery overlap. The probe uses no traffic or managed app
records, removes its successful service, and preserves native snapshots beside
the component report as `.overlap.native.json`.

`http-cancel.mjs <manifest> <new-results-directory>` extends the prepared HTTP
fixture with cancellation under traffic. The manifest uses the existing `app`,
`commits.A` and `commits["slow-ready"]`, plus fresh persisted `resetRequest` and
`updateRequest` UUIDs. Run it from the staged lab source with its Node runtime.
It first certifies A, starts 20 requests/s and a 20-second request, dispatches
slow B, cancels after native acknowledgement, and kills the existing deployer
after restore acknowledgement. It requires automatic terminal cancellation
after restart, one accepted restore, unchanged deadlines, only ready A responses
and zero request failures through 30 seconds after recovery. Raw requests,
receipts, normalized native observations and the original long response are
retained. A failure preserves the directory and managed app for inspection.

The 2026-11-12 real-control cancellation run passed with 1,535 short requests,
zero failures and only ready A responses. The original A request completed in
20,017 ms; cancellation recovered in 38,070 ms despite coordinator SIGKILL
after restore acknowledgement. One restore was accepted and the sampled peak
was three nonterminal tasks. Raw evidence is retained locally at
`/tmp/kayra-http-cancel-results/`, with the run log at
`/tmp/kayra-http-cancel-live.log`. The independent component's native overlap
snapshots are `/tmp/kayra-cancellation-component.json.overlap.native.json`.
These checks extend the HTTP subset; migrations and full lifecycle completion
remain subsequent work.

## Isolated one-shot interruption checks

`one-shot.mjs run <new-results-directory> <app-owned-web-image-digest>` runs
four disposable jobs, killing the coordinator process after Create, before
Start dispatch, after Start acknowledgement and after fencing acknowledgement.
Run it with the staged source's Node and dependencies on an isolated lab VM.
The image must contain `sh` and use the local registry's `<app>/web@sha256:…`
namespace. Jobs use 64 MiB/100 millicores, no network or mounts, and a fixed
60-second deadline. A never-started container reserves each job's stable name
after its exact ID is removed; the probe demonstrates late Start receives 404
and late Create conflicts. Production barriers remain retained. The probe
removes only its own barriers after every dispatch has settled.

Every completed job must have exactly one native Start event. The interrupted
pre-start job must have zero; its semantic outcome remains unknown. The
results include synchronized journals, normalized traces, Docker events, exact
image/Engine/API/Node versions and unchanged deadlines. Failures retain their
source and jobs. These are component checks for the job primitive, without
application admission or migration rollout integration. `http-coordinator.yml`
now runs them with its app-owned fixture image, fetches the summary and raw tar
archive before successful source cleanup, and the upgrade lab preserves both.

On 2026-11-12 all four corrected checkpoints passed against Engine 29.9.3,
API 1.56 and Node 24.22.1, using the HTTP component's pinned BusyBox image
`localhost:5000/coordinator-lab-28130d1f10774fe3a093107efb3828bf/web@sha256:5d0cfdad46188b05682bfa22f79d4933134db5eef2606b2904a32ef980e66edf`.
Raw journals, traces, native events and source provenance are preserved at
`/tmp/kayra-jobs-fixed-evidence/` and its adjacent `.tar`. A first integrated
run incorrectly assumed that this BusyBox image contained Node. It preserved
the unstarted attempt as unknown; its failed source remains at
`/var/lib/kayra/swarm/coordinator-source-_j_rxj3_` in the kept lab VM. The
portable `sh` fixture command corrected that lab failure.

The corrected combined component passed all 17 tasks, including evidence
fetches and successful-source cleanup. Its results are
`/tmp/kayra-jobs-fixed-component.json`, `.json.jobs.json` and `.json.jobs.tar`;
the run log is `/tmp/kayra-jobs-fixed-component.log`. Full CLI validation passed
551 tests with one skip; all 16 focused Linux checks passed.

## Application status-probe evidence

`migration-probe.mjs <new-results-directory> <app-owned-web-image-digest>`
exercises `applied`, `not-applied`, `unknown`, malformed private stdout, output
overflow and a nonzero process exit that prints applied. It uses the same
64 MiB/100 millicore, network-free disposable jobs as the interruption probe.
Only a successful process with complete bounded non-TTY stdout containing
`{"version":1,"outcome":"…"}` supplies a semantic outcome. Traces and journals
retain only its enum; the secret supplied to the malformed-output fixture must
not appear in either. No raw application output is exported.

All six cases passed on 2026-11-12 against Engine 29.9.3/API 1.56 and Node
24.22.1. The same source also passed all four native job SIGKILL checkpoints.
The run logs are `/tmp/kayra-probes-native-{jobs,probes}.log`; exported evidence
is retained at `/tmp/kayra-probes-native-evidence/`. The coordinator playbook
fetches `.probes.json` and `.probes.tar` before successful source cleanup, and
the upgrade lab retains both alongside job and HTTP evidence. This component
still enables no migration rollout or app admission capability.

The combined HTTP/job/probe component passed all 21 tasks, including evidence
export and source cleanup. Results are `/tmp/kayra-probes-component.json` with
`.json.probes.json` and `.json.probes.tar`; the log is
`/tmp/kayra-probes-component.log`. Full CLI validation passed 556 tests with one
skip, and all 30 focused Linux checks passed.

## Cold image and late creation

`one-shot-cold.mjs <new-results-directory> <fixture-image-digest>` creates an
unregistered disposable image namespace, pushes it, removes only that local
probe reference, and proves inspect returns 404. The executor must pull its
exact digest once, independently verify it and execute before the unchanged
deadline. Original and managed image references are never removed.

The same probe delays a duplicate native Create until the executed container
is deleted. Recovery must record and delete the newly arrived ID, retain the
original exit evidence and complete its name barrier. Docker events require
one Start for the original container and zero for the delayed container.
Successful probes remove their own barriers and disposable image references;
failures preserve evidence. The 2026-11-12 native run passed both checks against
Engine 29.9.3/API 1.56 and Node 24.22.1. Its log is
`/tmp/kayra-cold-race-native.log`, and exported evidence is retained at
`/tmp/kayra-cold-race-evidence/`. The coordinator playbook and upgrade lab retain
`.cold.json` and `.cold.tar` before source cleanup.

The combined HTTP/job/probe/cold-image component passed all 25 tasks, including
evidence export and successful-source cleanup. The result is
`/tmp/kayra-cold-component.json` with `.json.cold.json` and `.json.cold.tar`;
the run log is `/tmp/kayra-cold-component.log`. Full CLI validation passed 560
tests with one skip; all 34 focused Linux checks passed.

## Separate job deadlines

`one-shot-deadlines.mjs run <new-results-directory> <fixture-image-digest>`
covers scheduling expiry without execution, delayed preparation followed by a
full execution window, a still-running job after coordinator SIGKILL, late
success, and timely completion observed only after restart. The execution
deadline is persisted before Start and must remain identical after restart.
Docker completion timestamps and expiry flags remain separate from exit codes.
All five native cases passed on 2026-11-12 against Engine 29.9.3/API 1.56 and
Node 24.22.1. Raw results are `/tmp/kayra-job-deadlines-native-evidence/`, and
the log is `/tmp/kayra-job-deadlines-native.log`. The coordinator playbook and
upgrade lab retain `.deadlines.json` and `.deadlines.tar` before cleanup.

The late-success case deliberately demonstrates that a Docker job can run
past its deadline while the coordinator is absent. Recovery retains that exit
evidence and marks execution expiry; this is not native hard-timeout evidence.

The combined component passed all 29 tasks, including evidence export and
source cleanup. Its result is `/tmp/kayra-deadlines-component.json` with
`.json.deadlines.json` and `.json.deadlines.tar`; the log is
`/tmp/kayra-deadlines-component.log`. Full CLI validation passed 568 tests with
one skip; all 42 focused Linux checks passed, including legacy record recovery.

## Ordered migration phase

`migration-sequence.mjs run <new-results-directory>` mirrors the existing
Node-capable deployer image into an isolated app namespace. The fixture app
receives neither platform mounts nor a Docker socket. Its private HTTP service
owns effect counting and deduplication; the coordinator only executes declared
commands and interprets the normalized status-probe enum. No ports are
published and the fixture service is not routed.

Eight scenarios cover ordered steps, replay-safe effect-before-failure, unsafe
effect-before-failure with applied probe, unknown/not-applied holds, and SIGKILL
before Start, after Start acknowledgement and after durable step advancement.
Every job Start is counted from continuously collected Docker events. The safe
case makes two calls but one effect because the app deduplicates; this is not a
Kayra exactly-once claim. Unknown and not-applied unsafe work is held. Successful
runs remove only their own job barriers and synthetic state service; failures
preserve them with cleanup instructions.

All eight cases passed on 2026-11-13 against Engine 29.9.3/API 1.56 and Node
24.22.1. The synchronized run's clock offset was 171 ms; its context is
`/tmp/kayra-sequence-run2-context.json`, log `/tmp/kayra-sequence-run2-native.log`
and raw evidence `/tmp/kayra-sequence-run2-evidence/`. An earlier seven-case run
used a VM clock lagging after overnight suspension; its raw evidence remains at
`/tmp/kayra-sequence-initial-evidence/` and supplies no current UTC timing claim.

The component playbook checks the VM clock against its controller before any
effects and retains `.sequence.json` and `.sequence.tar` before successful
source cleanup. These remain phase-owner tests with trusted lab admission, not
real-deployer migration admission or retained-volume safety evidence.

The combined component passed all 34 tasks, including clock validation,
application-effect assertions, native Start counts, evidence export and source
cleanup. Results are `/tmp/kayra-sequence-component.json` with
`.json.sequence.json` and `.json.sequence.tar`; the log is
`/tmp/kayra-sequence-component.log`. All 55 focused Linux checks passed. The
serial CLI suite passed 581 tests with one skip. A parallel macOS run hit an
existing API terminal-session process-group `kill EPERM`; that focused test
passed immediately on recheck. No API/process implementation was changed.

## Indexed migration preparation

`migration-sequence.mjs indexed-run <new-results-directory>` runs the same
eight scenarios through the app index, lifecycle fence, ticket and durable
host resource book. Registration observation and build preparation are lab
fixtures; the Docker host observation and job effects use the real adapters.
This tests internal indexed preparation, not the public deployer pipeline.

The complete-plan digest owns the resource charge; the HTTP projection has a
separate digest. Admission records a 90-second scheduling deadline, and the
total preparation budget is fixed at acceptance. Child job records live inside
the same app envelope. Unresolved work retains the action and reservation.
Successful preparation persists a bounded HTTP handoff deadline without
promoting a release or settling capacity. HTTP execution, cancellation and
audited resolution remain prerequisites for enabling complete rollouts.

All eight native cases passed on 2026-11-13 against Engine 29.9.3/API 1.56 and
Node 24.22.1. Docker events verify at most one Start per execution container.
Before this run, the lab VM's NTP service was restarted to correct suspension
drift; measured clock offsets were 232 ms before and 499 ms after the run.
Context is `/tmp/kayra-indexed-preparation-context.json`, raw evidence is
`/tmp/kayra-indexed-preparation-evidence/`, and the log is
`/tmp/kayra-indexed-preparation-native.log`. The initial source staging attempt
failed during module import because its dependency symlink named a path inside
the deployer image rather than the VM. It created no fixture workloads; that
source remains preserved at
`/var/lib/kayra/swarm/indexed-preparation-source-qKFSeYEr`.

The component playbook and upgrade lab retain `.indexed-sequence.json` and
`.indexed-sequence.tar` before successful source cleanup. All 59 focused Linux
checks pass. Typecheck, lint and the serial CLI suite pass (596 tests, one skip).

The combined indexed-preparation rerun passed all 38 tasks. Its result prefix is
`/tmp/kayra-indexed-preparation-component-run2.json`, including
`.indexed-sequence.json` and `.indexed-sequence.tar`; the log is
`/tmp/kayra-indexed-preparation-component-run2.log`. The first combined run
matched a temporary Compose command container when locating the deployer. Its
source remains at `/var/lib/kayra/swarm/coordinator-source-tn2ahevp`; the passing
fixture filters one-off containers and requires one persistent deployer ID.

## Complete rollout HTTP handoff

`rollout-coordinator.mjs run <new-results-directory>` drives the indexed parent
through migrations, Swarm service operations and trusted TLS readiness. Its app
image is a disposable Node-capable image mirrored into the fixture's own registry
namespace. The same app-image service supplies migration/probe commands and the
HTTP fixture. The app's separate effect-counting service is synthetic, unrouted
and mount-free; this is not retained-database or public-deployer integration.

Four native scenarios passed on 2026-11-13: initial complete deployment, SIGKILL
after HTTP acknowledgement, automatic rollback preserving the previous complete
release certificate, and an unknown migration that never creates an HTTP
candidate. Recovery dispatched zero additional job Starts or HTTP writes after
the acknowledged update. Docker events verified exactly five job Starts, one
per execution container across all four scenarios. The rollback case recovered
in 45,679 ms; this is not an uninterrupted rollback or continuity measurement.

Engine was 29.9.3/API 1.56, Node 24.22.1, and the fixture image digest is recorded
in the machine-readable result. VM clock offsets were 138 ms before and 135 ms
after the run. Context is `/tmp/kayra-rollout-handoff-run2-context.json`, raw
evidence `/tmp/kayra-rollout-handoff-evidence/`, and the log is
`/tmp/kayra-rollout-handoff-run2-native.log`. Exported journals and traces contain
no synthetic private values. An initial fixture embedded dollar-bearing JS
directly in a Compose command and was correctly refused before HTTP intent.
The corrected fixture imports encoded app code through a literal command; the
application-plan validator was not relaxed. Failed source and its synthetic
state service remain preserved at
`/var/lib/kayra/swarm/rollout-handoff-source-vIhsu5We`; cleanup is
`sudo docker service rm 2uv0nyzvjoud1nphtvph7ys8m` after inspecting the evidence.

The component playbook and upgrade lab retain `.rollout.json` and `.rollout.tar`
before successful source cleanup. All 67 focused Linux checks pass. Typecheck,
lint and the serial CLI suite pass (604 tests, one skip). Public complete-rollout
acceptance remains disabled pending audited resolution, cancellation before
handoff and normal pipeline integration.

The combined component passed all 42 tasks, including legacy HTTP recovery,
native overlap, jobs, probes, cold images, deadlines, ordered/indexed migrations,
complete rollouts, evidence export and successful-source cleanup. Results use
the prefix `/tmp/kayra-rollout-handoff-component.json`, including `.rollout.json`
and `.rollout.tar`; the log is `/tmp/kayra-rollout-handoff-component.log`. The VM
and controller clocks still matched at completion.

## Unstarted cancellation and admission recovery

`rollout-unstarted.mjs run <new-results-directory>` kills the real filesystem
writer before reservation, after reservation but before the app marker, and
after cancellation proof but before resource settlement. It then waits beyond
the original 90-second admission deadline. An unreserved request fails without
gaining a new window; a previously accepted reservation reconstructs its
original decision and can be cancelled safely. Restart settles a cancelled
request's conservative reservation from its durable proof.

All three native cases passed on 2026-11-13 against Engine 29.9.3/API 1.56 and
Node 24.22.1. Application runtime ports are forbidden and recorded zero calls.
Host observations use the real read-only adapter. Registration/build inputs and
the deliberately unexecuted image references are fixtures; this test makes no
image-availability, application-readiness or public-deployer claim. Context is
`/tmp/kayra-rollout-unstarted-context.json`, raw evidence is
`/tmp/kayra-rollout-unstarted-evidence/`, and the log is
`/tmp/kayra-rollout-unstarted-native.log`. VM clock offsets were 379 ms before
and 313 ms after the run. The playbook and upgrade lab retain `.unstarted.json`
and `.unstarted.tar` before successful-source cleanup.

Typecheck, lint and the serial CLI suite pass (611 tests, one skip). Started
preparation still requires its own cancellation/recovery path; observing no
container cannot justify an unstarted completion after intent was persisted.

The combined unstarted-settlement component passed all 46 tasks, including
evidence export and successful-source cleanup. Its prefix is
`/tmp/kayra-rollout-unstarted-component.json`, including `.unstarted.json` and
`.unstarted.tar`; the log is `/tmp/kayra-rollout-unstarted-component.log`. The VM
and controller clocks still matched after completion.

## Current host authority

`migration-sequence.mjs host-run <new-results-directory>` injects unavailable
normalized host observations into the indexed owner while using real Docker
jobs. It changes no Swarm role or host configuration. Three native cases passed
on 2026-11-13: unavailable before Create (zero app calls/Starts), unavailable
after Create (zero app calls/Starts), and unavailable after Start (one completed
app effect, fenced successfully, with HTTP handoff refused). Docker events count
Starts, and the app-owned fixture checks its effects independently. Expected
held cases are inspected and cleaned only as lab teardown; the coordinator does
not label them resolved or release their reservations.

Engine was 29.9.3/API 1.56 and Node 24.22.1. Clock offsets were 734 ms before and
464 ms after the run. Context is `/tmp/kayra-rollout-host-context.json`, evidence
`/tmp/kayra-rollout-host-evidence/`, and the log
`/tmp/kayra-rollout-host-native.log`. Exported traces contain no synthetic private
values. The playbook and upgrade lab retain `.host.json` and `.host.tar` before
successful-source cleanup. Typecheck, lint and the serial CLI suite pass (617
tests, one skip). These remain fault-injected authority checks, not host-loss or
public-deployer integration evidence.

The host-authority combined component run passed all 50 tasks on the same
preserved VM. Reports use `/tmp/kayra-rollout-host-component.json`, including
`.host.json` and `.host.tar`; its log is `/tmp/kayra-rollout-host-component.log`.

### Audited migration resolution

`migration-sequence.mjs resolution-run <new-results-directory>` uses real Docker
jobs, app-owned effect counters, indexed admission and the local deployment
control interface. It tests applied/not-applied operator assertions, then
SIGKILL immediately before and after the synchronized audit journal write.
Reopening must retain the original deadline and runtime evidence, and must
never repeat the unsafe migration or its completed status probe. An applied
assertion resumes preparation; a not-applied assertion fails the candidate and
settles its reservation. This fixture stops before HTTP and uses fixture
registration/build ports; it does not establish public pipeline integration.

The normal operation catalog offers `app.migration.resolve` and
`app.migration.audit`, through CLI/API/UI/MCP. For example:

```sh
kayra app migration audit SERVER APP RUN_UUID schema
kayra app migration resolve SERVER APP RUN_UUID schema applied --reason 'Verified application migration ledger'
```

Resolution requires every attempt to have completed fencing and each exact
owned inert barrier to remain observable. It cannot override a running or
unfenced job. An assertion after the original deadline is retained as audit
evidence and fails the candidate. The actor records the privileged local
control identity, not an unauthenticated person name from request input.

The four resolution cases passed on `kayra-builder-indexed-20261111080734`.
Context is `/tmp/kayra-migration-resolution-context.json`, evidence is
`/tmp/kayra-migration-resolution-evidence/` and its `.tar`, and the native log is
`/tmp/kayra-migration-resolution-native.log`. Clock offsets were 557 ms before
and 349 ms after. All cases observed exactly one migration Start and one probe
Start, with no repeats after operator resolution or either SIGKILL checkpoint.
App-owned effect counts were one for applied cases and zero for not-applied.
Exported evidence contains no synthetic private values. Another 44 focused
checks passed on Linux; the normal client parity and shell-transport checks
passed on the Mac. The combined component rerun is recorded separately.

### One-shot image health isolation

`one-shot-health.mjs <new-results-directory>` derives a uniquely named fixture
image from the pinned deployer image and adds a failing one-second inherited
health check. A real migration container explicitly overrides it with
`Healthcheck.Test = ["NONE"]`, completes its declared command, and has no
Docker health state. Its never-started name barrier also disables the check.
The updated adapter refuses to Start a prepared container whose check is not
explicitly disabled. Long-running HTTP health checks are unchanged.

This passed on the preserved VM with Docker 29.9.3/API 1.56 and Node 24.22.1.
The job completed in 4,115 ms; context/result/native logs use the prefix
`/tmp/kayra-job-health-`, including `context.json`, `result.json` and
`native.log`. Clock offsets were 567 ms before and -14 ms after. All 28 focused
checks passed on Linux and the Mac; the serial CLI suite passed 632 tests,
with one skip. The successful standalone source was removed after export;
the original failed VM remains preserved.

The resolution combined run passed 54 tasks with reports under
`/tmp/kayra-migration-resolution-component.json` (`.resolution.json` and `.resolution.tar`);
the health-isolation combined run passed 58 tasks under
`/tmp/kayra-job-health-component.json` (`.job-health.json` and `.job-health.tar`).
Both successful combined sources were removed after export. The failed VM stays.

### Explicit cleanup recovery

`one-shot-cleanup.mjs run <new-results-directory>` lets the original job cleanup
authority actually expire while two isolated jobs remain running. Each new
cleanup action persists a separate thirty-second deadline; SIGKILL before
fencing or after acknowledgement must reconstruct that authority, fence the
exact owned job and observe a never-started barrier, with exactly one original
application Start. This is the native primitive with fixture authorization.

`migration-sequence.mjs cleanup-run <new-results-directory>` exercises indexed
admission, normal cleanup/audit/resolve control, the app-declared status probe,
and SIGKILL after native cleanup acknowledgement. Runtime execution evidence
must stay unchanged. The native fixture deliberately makes only the original
migration fence unavailable; probe fencing remains available. Registration/build
ports remain fixtures, and HTTP continuity is not asserted by these cases.

The first primitive attempt failed before application Create because its fixture
hashed raw JSON rather than the normalized job plan. Failed source/evidence is
preserved at `/var/lib/kayra/swarm/job-cleanup-source-r7zzkw2Y` on
`kayra-builder-indexed-20261111080734`. No job containers were created by that
attempt. After inspecting/exporting it, remove only that source with:

```sh
multipass exec kayra-builder-indexed-20261111080734 -- sudo rm -rf /var/lib/kayra/swarm/job-cleanup-source-r7zzkw2Y
```

The combined harness exports `.job-cleanup.json`/`.job-cleanup.tar` and
`.migration-cleanup.json`/`.migration-cleanup.tar`. New public migration admission
stays disabled; these recovery commands operate on already retained experiments.

Two further fixture failures are preserved: the second attempt omitted the
cleanup journal directory (`/var/lib/kayra/swarm/migration-cleanup-source-QTuwJulZ`);
the third lost historical Docker Start events during its thirty-second wait
(`/var/lib/kayra/swarm/migration-cleanup-source-NvDRcabz`). The successful rerun
streams bounded events from before job creation. Context/log/container inventories
for those attempts use `/tmp/kayra-migration-cleanup-attempt2-` and `attempt3-`.
After inspecting and exporting those failed runs, their exact retained objects
can be removed with the following commands; the lab never runs this cleanup:

```sh
multipass exec kayra-builder-indexed-20261111080734 -- sudo docker rm 81166d7ed8c8ec983d64f6b95b63afff8e2890fa0148be24e74546c4aaef0878 91502da4eb8d9b903f5ad76deb8b31cf54dabf1bdb3b29ae5720505ee0ac769d 917b028b35b92f77e218dd55e1723cdc23bb7971e9ed3a3284827aded1077bdc 46014028b1a280f93527b8e66fb62580d56e23fdb72d4cd39b3a81b0d1964af9
multipass exec kayra-builder-indexed-20261111080734 -- sudo rm -rf /var/lib/kayra/swarm/migration-cleanup-source-QTuwJulZ /var/lib/kayra/swarm/migration-cleanup-source-NvDRcabz
```

All four final native cleanup cases passed: two primitive expiry/SIGKILL cases
and two indexed cleanup/probe/operator-resolution cases, including a kill after
Docker acknowledges cleanup. Exact execution evidence and deployment deadlines
remain unchanged; the indexed cases each observed one migration Start and one
probe Start, with one app-owned effect. Context is
`/tmp/kayra-migration-cleanup-context.json`, raw evidence is
`/tmp/kayra-migration-cleanup-evidence/` and its `.tar`, and native logs are
`/tmp/kayra-migration-cleanup-primitive.log` and `...-indexed.log`.
Clock offsets were 502 ms before and 183 ms after. Private-value scans passed.
The serial CLI suite passed 643 tests with one skip, and 70 focused Linux checks
passed using byte-identical CLI source/tests. The successful standalone source
was removed after export; failed sources and the original VM remain preserved.

The combined audited-cleanup run passed all 66 tasks. Reports use
`/tmp/kayra-migration-cleanup-component.json`, including `.job-cleanup.json/.tar`
and `.migration-cleanup.json/.tar`; its log has the same prefix. The ending VM
clock offset was 152 ms. Successful component source was removed after export.

### Preparation cancellation

`rollout-cancellation.mjs run <new-results-directory>` exercises cancellation
between native Create and Start, after an app-owned effect with SIGKILL after
the synchronized cancellation intent, after an unknown status probe with audited
resolution, and after migration readiness before HTTP handoff. The interrupted
case verifies the original migration is still running after writer death, then
reconstructs cancellation under the same identity and deadline. App-owned counters
and bounded live Docker events detect unsafe replay and successor execution.

These are indexed/native preparation cases with fixture registration/build ports;
they do not establish public migration pipeline integration or HTTP continuity.
The combined harness exports `.cancellation.json` and `.cancellation.tar`.
Normal operator commands share the same catalog across clients:

```sh
kayra app deployment status SERVER APP
kayra app deployment cancel SERVER APP REQUEST_UUID
```

A cancellation may stay held for app-provided probe or audited operator recovery.
It preserves applied data and existing verified-release history; an acknowledgement
is not evidence that the app was rolled back or that a running SQL query stopped.

All four native cancellation cases passed on the preserved VM, with zero
migration Starts between Create and cancellation, one migration plus one probe
Start in each after-effect case, and no HTTP child or successor migration in
cancelled prefixes. The interrupted case observed the original migration still
running after writer death and reused the persisted cancellation timestamp.
The ready case retained its previously issued HTTP deadline. Context is
`/tmp/kayra-preparation-cancel-context.json`, raw evidence is
`/tmp/kayra-preparation-cancel-evidence/` and its `.tar`, and the native log is
`/tmp/kayra-preparation-cancel-native.log`. Clock offsets were -265 ms before
and 250 ms after. The synthetic private-value scan passed. Ninety focused Linux
checks passed, and the serial CLI suite passed 660 tests with one skip; 21 web
tests and CLI/web typecheck/lint/build checks passed. Successful standalone
source was removed after export; the original failed VM and failed prior labs
remain preserved.

### Expired ready handoff

`rollout-handoff-expiry.mjs run <new-results-directory>` prepares two admitted
ready releases using fixture build/image inputs, waits past their original HTTP
deadlines, and SIGKILLs a writer immediately before and after its synchronized
terminal failure record. Reopening settles each original request and reservation
without creating an HTTP child, running an application job or refreshing any
deadline. Real Swarm host observations are read-only. These are journal/admission
component checks; they do not establish SQL or HTTP continuity. Unit tests also
cover already-applied migrations, preservation of the previous active release,
and stale completion against a newer reservation.

The combined harness exports `.handoff-expiry.json` and `.handoff-expiry.tar`.
Reproduce using the same immutable source staging and `http-coordinator.yml`
command above. The raw archive includes original deadlines, public projections,
private lifecycle state and host reads. Preserve failed sources and inspect their
`failure.json` before removing only the printed source path; preserve failed VMs.

Both native checkpoints passed on the preserved VM. Application runtime calls
were zero; both original deadlines and absent active releases were retained.
Fifteen focused Linux checks passed. Evidence is
`/tmp/kayra-handoff-expiry-evidence/` and `.tar`; context and versions are in
`/tmp/kayra-handoff-expiry-context.json`. The Engine and CLI were 29.9.3,
API 1.56, Compose 5.7.0 and Node 24.22.1 on Ubuntu 24.04.5 ARM64.
Clock offsets were 232 ms before and 250 ms after.
