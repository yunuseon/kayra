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

### Host migration policy publication

The platform setup module publishes the host-only timeout ceiling under its
existing lock. `python3 -B ci/tests/swarm-host/test_host.py` includes check-mode,
policy update, lost-publication acknowledgement and untrusted-file cases; these
require Linux root and stub Docker effects. The real filesystem reader check is
`node --test cli/test/deployment/migration-policy.test.ts`; it verifies root-owned
0444 files, atomic replacement, hard-link/symlink refusal and bounded content.
On the preserved VM all fifteen Python host checks and both focused policy checks
passed. Context is `/tmp/kayra-migration-policy-context.json` and raw output is
`/tmp/kayra-migration-policy-linux.log`. This does not exercise a platform upgrade
or enable public migration-bearing admission. Successful isolated test sources
were removed; the previously failed VM remains preserved.

### Dependency-free Compose startup

The full policy upgrade from 0.23.0 exposed eager experimental contract imports
in `ctl`, which also loaded when starting the builder and deployer. Normal server
images intentionally omit those optional dependencies. The migration command now
loads its validators only when invoked; normal startup and existing commands
remain dependency-free. A regression test copies only server sources to an
isolated directory without `node_modules`, loads the common entrypoint, reads
legacy run history, and checks a clear refusal for unavailable migration control.

The failed VM `kayra-policy-upgrade-20261113194653` and its original sources are
preserved. Logs: `/tmp/kayra-policy-upgrade-20261113194653.log` and the fleet log
under `/var/folders/pm/02mk70kx247bbsttcvzkqtw00000gn/T/tmp.kZxmZDgKh7/`.
After inspection, explicit cleanup is the lab's printed `kayra down lab` command
from that temporary fleet, followed by removing only that temporary directory.
No cleanup of the failed lab has been performed. A new unique VM tests the fix;
its context is `/tmp/kayra-import-upgrade-context.json`.

Four invocations against the failed lab's original builder/deployer images also
passed with the corrected frozen source mounted read-only and without a Docker
socket, app secrets or network access: both common entrypoints loaded, and both
images answered legacy run-history queries. Raw image identities and output are
in `/tmp/kayra-optional-image-smoke.json`. Only the successful temporary source
was removed; original failed lab sources and stored container evidence remain preserved.

### Indexed complete-plan control

The indexed composition can now compile complete plans from retained builder
artifacts and trusted host policy through its existing preview/prepare interface.
Preview is read-only; version-two receipts preserve complete-plan identity and
total deadline. Legacy HTTP request retries keep version-one receipts. Focused
checks cover actual coordinator/journal progression with fake runtime ports;
36 passed on Linux, with context `/tmp/kayra-complete-control-context.json` and
raw output `/tmp/kayra-complete-control-linux.log`. These tests do not exercise
the real builder or native workload effects. The integrated pipeline experiment
remains required before claiming complete migration support.

### Real-builder migration and HTTP integration

With `--indexed-registration --swarm-host`, the upgrade lab now creates a new
`rollout-complete` application from `complete-fixture/`. Real builder artifacts
retain the complete migration declaration, exact image digests and trusted host
ceiling. An external app-owned HTTP ledger records unsafe effects; it has no
platform secrets, socket, published port or writable host mount. This tests the
migration protocol without claiming SQL-engine or retained-volume acceptance.

Release A applies once and serves a thirty-second baseline. Release B applies
its effect, stays running while the coordinator is killed, then exits with an
error. Its declared status probe must report `applied` before native HTTP B
starts. The observer requires exactly two migration Starts, one probe Start and
one effect per release. It checks zero failed or premature HTTP requests at
20 requests/second, fresh and persistent connections, no client retries and a
two-second request timeout, with thirty seconds of traffic after convergence.
Source staging and final measurements require synchronized VM/controller clocks.

The lab exports `.complete.json`, `.complete.tar`, `.complete.source.json`,
`.complete.clock.json` and `.complete-fixture.bundle` under its usual
`/tmp/kayra-swarm-platform-<vm>` prefix. Raw archives include per-request records,
Docker events, public status/receipts, app-owned effect counts and CPU/memory
samples. The summary records exact Engine, CLI, Compose, OS, Node and image
versions. The fixture bundle preserves the actual A/B commits.

Reproduce through the normal full-lab command:

```bash
bash test/lab/upgrade.sh --from 0.23.0 \
  --vm-name kayra-complete-upgrade-$(date -u +%Y%m%d%H%M%S) \
  --indexed-registration --swarm-host
```

Passing VMs are destroyed unless `--keep`; failed sources, ledger/runtime state,
fleet and VM remain for inspection. After exporting failed evidence, use only
the lab's printed cleanup command. Ordinary fleet registration and the remaining
worker, singleton, maintenance, removal and data-retention acceptance are still
separate requirements.

`test/lab/stage-source.yml` transfers trusted code as one archive and records its
SHA-256 instead of copying each file separately. A VM smoke check verified all
285 staged files byte-for-byte; it passed all eleven tasks in 141 seconds on the
then-loaded host. Proof is `/tmp/kayra-source-stage-smoke-context.json`,
`/tmp/kayra-source-stage-smoke.source.json` and `.log`. The old transfer had spent
over forty minutes staging individual files before workload effects began.
The interrupted run `kayra-import-upgrade-20261114000217` is preserved on disk;
its logs and fleet are under the temporary directory recorded in
`/tmp/kayra-import-upgrade-context.json`. It passed the normal Compose upgrade,
cache/policy/rollback/GC/poll paths and mixed TLS routing before interruption.

The failed `kayra-policy-upgrade-20261113194653` and idle component VM
`kayra-builder-indexed-20261111080734` are also preserved on disk and stopped to
free resources. Restart an individual lab with `multipass start <name>` and
resynchronize its clock before any new timed experiment. Daemon failure logs
were exported to `/tmp/kayra-policy-upgrade-failure/`; idle-container metadata is
`/tmp/kayra-builder-indexed-preserved-containers.txt`. No failed VM was deleted.

The full run recorded in `/tmp/kayra-complete-upgrade-context.json` passed the
normal Compose paths and mixed TLS setup, then was invalidated by a two-hour
host suspension during a timed component case. Its failed source, journals and
VM remain preserved; this is not a full upgrade acceptance pass.

A separate real-pipeline rerun on that VM passed: **3,029 requests, zero failures,
zero premature exposure**, 19.993 requests/second and a 230.2 ms maximum start
gap. The coordinator was killed after B's unsafe migration effect; the original
container continued independently, failed, and the declared probe reported
`applied`. There were exactly two migration Starts and one probe Start across
A/B, one effect and one call per operation, and replay preserved the original
plan/deadline. Host/VM clock offsets were 500 ms before and 295 ms after.

Evidence: `/tmp/kayra-complete-live2.json`, `.json.tar`, `.json.source.json`,
`.json.clock.json`, `-context.json`, `-inputs.json` and `-fixture.bundle`.
The archive contains requests, live Docker events, status trace and resource
samples. Exact versions: Ubuntu 24.04.5 ARM64, kernel 6.8.0-147, Docker Engine/CLI
29.9.3 (API 1.56), Compose 5.7.1, Node 24.22.1, Traefik 3.7.16 and socket-proxy
0.5.0; immutable application/shared image identities are in the summary.

The first targeted run **failed with 116 failed requests out of 3,042**. After B
was promoted, its Node fetch-based health probe exceeded the one-second timeout;
Swarm restarted B after its failure-monitoring window. App requests still
reported ready until termination; there was no OOM. Evidence is preserved in
`/tmp/kayra-complete-live-failed.tar` and
`/tmp/kayra-complete-live-health-failure.json`. The passing rerun uses a cheaper
built-in HTTP health probe; CPU, health timeout, traffic rate, client timeout,
refresh interval and retry policy remain unchanged. This does not establish
uninterrupted recovery from a real post-readiness application failure.

Eight local lab checks, Ansible syntax/validation and the byte-identical staging
smoke passed. Full upgrade acceptance and the remaining application roles are
still outstanding.

### Deployment plan image pins

The owner publishes `/deployment/pins` through `ctl lifecycle pins APP` and
`kayra app deployment pins SERVER APP`, also available through the API/UI/MCP
operation catalog. The read model groups exact images by active, last-known-good,
candidate, rollback and unresolved plan references. It retains the separate
complete-plan/workload identities, refuses missing/corrupt descriptions and
excludes materialized inputs. `gcSafe: false` is mandatory: live attachments,
legacy Compose inventory and unresolved builds are not covered; build pins are
still exported separately and destructive Swarm-host GC remains refused.

Seven focused checks cover promotion/restart, pending and held migration/HTTP
plans, cancellation, missing/corrupt descriptions, scope and contract validation.
The full CLI suite passed 681 tests with two existing skips; the additional HTTP
pin test passed in the focused seven-case run. Web type/lint/build and 21 tests
passed. A Linux subset passed 35 tests using an isolated source on the preserved
failed VM, with fake workload ports, not a second native rollout. Evidence is
`/tmp/kayra-deployment-pins-linux2-linux-context.json` and
`/tmp/kayra-deployment-pins-linux2-linux.log`; its successful source was removed.
An earlier isolated Linux attempt included the ESLint-based architecture test
without its development dependency. Its source and failure log are preserved at
`/tmp/kayra-deployment-pins-linux-context.json` and
`/tmp/kayra-deployment-pins-linux.log`; architecture checks pass locally with
the full development dependencies installed. No failed VM was deleted.

### Observer corrections found in the fresh full upgrade

`kayra-complete-acceptance-20261114041014` passed the normal Compose upgrade,
restart/cache/policy/rollback/GC/poll paths, mixed TLS routing, all 79 component
playbook tasks and real indexed Swarm HTTP promotion. Its complete migration
fixture then failed before ledger creation: `docker compose images -q` returned
a container image config digest which this Engine could not resolve for
`docker run`; the named platform image resolved to a different available image
identity. The fixture now resolves the existing persistent coordinator's trusted
image reference with `docker image inspect`, then runs the resolved immutable
identity. Both the container config digest and selected image reference are
recorded. No replacement Node image is pulled for this fixture.

The VM, failed source and fleet remain preserved. Context:
`/tmp/kayra-complete-acceptance-context.json`; full/inner logs:
`/tmp/kayra-complete-acceptance-20261114041014.log` and the `lab.log` under
`/var/folders/pm/02mk70kx247bbsttcvzkqtw00000gn/T/tmp.RcUvI1mUdm`.
This run is not reported as a complete upgrade pass.

A separate run preserved in `/tmp/kayra-complete-live3-failed.tar` returned
**3,149 HTTP 200 responses with zero request failures** and completed migration
recovery and B promotion. Its observer rejected two successful old-A responses
whose readiness had turned false while A drained after SIGTERM. Candidate B
had no such responses. The premature-exposure assertion now scopes readiness to
the candidate release, consistently with the existing HTTP matrix, while all
request errors and non-200 responses still fail the experiment. Raw old-release
draining responses remain recorded separately. The original failed observation
is retained; a corrected observer must pass a fresh run before acceptance.

### Immutable image metadata admission

New experimental HTTP and complete-plan proposals now inspect immutable image
metadata through a typed runtime port before accepting workload intent. The
adapter reads the existing private registry by digest, verifies manifest/config
hashes and sizes, selects one unambiguous Linux ARM64/v8 or AMD64 image, and
refuses inherited `VOLUME` declarations. It never pulls images or writes Docker
objects. Reads share one ten-second budget and one-MiB limits, refuse redirects,
and ignore descriptor URLs. Duplicate/case-aliased keys, invalid UTF-8, excessive
nesting and excessive JSON token counts are refused; metadata values never enter
public errors. Nested/ambiguous indexes and extra platform-feature requirements
are unsupported. Existing Compose and accepted experimental journal intents are
not retroactively reinterpreted.

The full CLI suite passed **690 tests, two existing skips**, including eight
registry cases. Type/build/lint checks, shell/Node syntax, and Ansible/YAML
validation passed. A corrected real-builder migration/HTTP run passed **3,025
requests, zero failures, zero premature exposure**, at 19.998/s, maximum start
gap 121.6 ms; VM/controller offsets were 338 ms before and 210 ms after. Evidence:
`/tmp/kayra-complete-live4.json`, `.json.tar`, `.json.source.json`,
`.json.clock.json`, `-context.json` and `-fixture.bundle`. The source was frozen
before the later JSON ambiguity hardening; it establishes the positive routing
path, not that later parser change.

A real builder then produced commit `830bff52bdc810dd19e9e7c91cf49fbecf67afdb`
with `VOLUME ["/unsafe-lab-volume"]`. Preview and two prepares of request
`706869fb-a884-4880-8edf-a5b856ae552e` were refused. The existing active release
and deployment pins were unchanged, with **zero app container writes and zero
new Docker volumes**. All fifteen observer playbook tasks passed. Evidence:
`/tmp/kayra-image-admission-native.json`, `.json.tar`, `.json.source.json`,
`-context.json`, `-installed-source.json`, `-fixture.bundle` and `.log`.
The ledger and original failed VM remain preserved; only the successful observer
source was removed.

`/tmp/kayra-image-admission-native-metadata.json` independently records the
installed final adapter accepting the active image and refusing the inherited
volume image, with three production source hashes checked byte-for-byte against
the checkout. Active image digest: `ad34c68f1e0056a3d4d2e8fab0c956eb77f65f904a3a8c723be3e13d228cd668`;
refused image digest: `b26a9ca0dd7b34e8467c792a6a11a0c559c1b6ce0fea46106ebde95a63548fec`.
The final native refusal used the hardened JSON parser. Both raw archives passed
a scan for the fixture's resolved secret value.

The full upgrade lab now adds this negative check after the A/B integration,
exports `.image-admission.json`, `.image-admission.tar` and
`.image-admission.source.json`, and includes C in `.complete-fixture.bundle`.
A separate fresh full upgrade is running from the clean committed parent
`0067b8e` (`/tmp/kayra-corrected-acceptance-context.json`); it excludes this later
image-admission code. The previous failed VM
`kayra-complete-acceptance-20261114041014` was stopped only after proving no
one-shot jobs were running and exporting its metadata. Its disk, sources and
fleet remain preserved; no failed VM was deleted.

### Current runtime health projection

`kayra app deployment health SERVER APP` (`ctl lifecycle health APP`) observes
current owned Swarm HTTP tasks separately from the historical active-release
certificate. API/UI/MCP clients expose the same operation. The coordinator
publishes a typed snapshot for the existing platform `/health`; the platform
neither reads private journals nor guesses a backend from Docker containers.
Missing/unavailable observations fail explicitly. Historical tasks are counted
but do not make a currently available service unhealthy. Compose health remains
on its existing path. Reading health never promotes or mutates a release.

Validation: full CLI suite **698 passed, two existing skips**; fourteen focused
health cases; CLI type/build/lint and web type/lint/build plus **21 web tests**.
Cases cover overlap, current/historical failures, missing or foreign tasks,
unchanged certification, ownership conflicts, unavailable ports and private
error suppression. The normal dependency-free entrypoint tests still pass.

Native observation passed all ten tasks on the preserved failed full-upgrade VM:
**one current healthy task, four ignored historical tasks with actual probe
timeouts, platform HTTP 200/healthy, unchanged release certificate and container
identities**. Swarm records these gracefully terminated, health-failed historical
tasks as `complete`, so the observer records both task state and container probe
failure evidence. Its earlier task-state-only assertion failed and is preserved
in `/tmp/kayra-runtime-health-native.log` and
`/var/lib/kayra/swarm/runtime-health-source-rwi6bslm`; this was an observer failure,
not a false healthy runtime report. The corrected evidence is
`/tmp/kayra-runtime-health-native2.json`, `.json.source.json` and `.log`.
Installed production source/context is `/tmp/kayra-runtime-health-native-context.json`
and `-installed-source.json`. The original coordinator image is preserved under
`kayra-lab-preserved/deployer:20261114114523`; original failed app containers,
sources and journals remain on that VM. Only the successful observer was removed.

The fresh full run at clean `0067b8e` passed normal Compose paths, mixed TLS,
all 79 component tasks and real migration recovery/B promotion, then **failed
with 233 request failures out of 3,054** during post-convergence traffic. B's
one-second Node health probe timed out and Swarm restarted B after promotion.
There was no OOM (over 3 GB available memory); CPU peaked at 98.6%. Original
failed run/archive and diagnostics are preserved at
`/tmp/kayra-corrected-acceptance-failed.tar`,
`/tmp/kayra-corrected-acceptance-failure-summary.json` and
`/tmp/kayra-corrected-acceptance-health-failure.json`. This is not a full pass.

Three same-container, quarter-CPU timing samples, including Docker exec overhead,
measured Node probes at 448–929 ms and equivalent Bash HTTP probes at 77–166 ms
without traffic load. Exact samples are `/tmp/kayra-health-probe-cost.json`.
A lighter app-owned fixture probe will be tested separately with the same
readiness semantics, resource/time budgets and zero-failure traffic criteria.
The health projection does not claim worker/maintenance/removal semantics or
routed readiness; those acceptance checks remain outstanding.

### Lower-cost integration readiness fixture

Only `complete-fixture/` now uses `bash /health.sh` for its declared health check.
It makes one loopback HTTP readiness request, accepts the fixture's HTTP 200
response and drains the small body. It has no retry loop, Node startup, extra
package install or traffic-policy change. The Node server and pinned base image
remain the same. Limits stay at 128 MiB/0.25 CPU, health interval two seconds,
timeout one second, retries two, start period twenty seconds; rollout monitoring,
shutdown grace, refresh, 20/s load and two-second request timeout are unchanged.
The existing HTTP matrix fixture and previously frozen sources are unchanged.

Ten lab checks pass, including ready/not-ready status, exactly one request per
probe and refusal of an invalid port. This fixture change follows measured
Node-probe timeouts and the same-container timings above; it does not turn the
failed 233-request run into a pass or establish universal readiness guarantees.
The fresh upgrade from published `0.23.0` to clean commit `ce6f443` passed on
2026-11-14 in `kayra-health-budget-20261114125938` and destroyed its successful
VM. Normal Compose deploy/cache/policy refusal/rollback/GC, restart restoration,
TLS/Authelia verification, all 79 component tasks, indexed Swarm registration
and real builder promotion passed. The migration/restart integration recorded
2,986 short requests at 20.0005/s, zero failed requests and zero premature B
responses (largest request-start gap 192.2 ms). There were exactly two migration
starts, one status-probe start and one effect per migration operation. Replaying
the interrupted request retained its original plan and absolute deadline.

The same run refused the inherited-volume image at preview and both prepare
attempts with zero app workload writes or anonymous volumes, then reported the
current healthy task while ignoring one historical shutdown task. Final
`kayra verify lab` passed. Versions: Ubuntu 24.04.5 ARM64/kernel
6.8.0-147-generic, Docker Engine/CLI 29.9.3/API 1.56, Compose 5.7.1 and Node
24.22.1; exact shared-image digests and source manifests are in the results.

Reproduction: `bash test/lab/upgrade.sh --from 0.23.0 --vm-name
kayra-health-budget-<timestamp> --indexed-registration --swarm-host` from the
recorded source. Raw log: `/tmp/kayra-health-budget-20261114125938.log`.
All machine-readable results and archives share the prefix
`/tmp/kayra-swarm-platform-kayra-health-budget-20261114125938`, including
`.complete.json`, `.complete.tar`, `.complete.source.json`, `.complete.clock.json`,
`.image-admission.json`/`.tar` and `.runtime-health.json`.
The subsequent ShellCheck correction renames only the unused response-drain
variable; it is not part of the frozen lab source. Earlier failed runs remain
failures and are preserved. This pass does not complete worker, maintenance,
retained-data, lifecycle-removal or integrated resource-failure acceptance.

### Integrated candidate memory exhaustion

`candidate-oom.yml` builds a fourth exact fixture commit through the existing
builder, then submits it through the running coordinator after the migration
and image-admission checks. This candidate has no migrations. On its first
routed application request it arms a ten-second timer, then touches 512 MiB
inside the unchanged 128 MiB container limit. Healthy A/B have no allocation
configured. The observer must see a matching Docker OOM event and retained
container `State.OOMKilled`, native `rollback_completed`, and the coordinator's
certified previous B within 90 seconds of the OOM. Candidate promotion or a held
operation fails the test. Replaying the UUID must preserve plan and deadline.

The observer sends 20 short requests per second, split between fresh and
persistent connections, with a two-second timeout and no retries. It requires
30-second, failure-free B baseline and stable recovery periods, no premature
candidate exposure, and records all intervening failures and their time window
separately. This is not an uninterrupted-rollback assertion. It captures a live
bounded Docker event stream before submission, lifecycle observations, app
logs, per-request results, VM CPU/memory and exact Docker/Node versions. Host
available memory must stay above 512 MiB; this tests container OOM, not global
host OOM. No Docker-root or application-data filesystem is filled.

The upgrade lab exports `.candidate-oom.json`, `.candidate-oom.tar`,
`.candidate-oom.source.json` and `.candidate-oom.clock.json` under its usual
`/tmp/kayra-swarm-platform-<vm>` prefix. Failed observers, workloads and VMs are
preserved; only successful observer sources are removed. The harness is added
but native acceptance is pending.

### Concurrent admission with coordinator restart

`admission-race.yml` registers and builds two new explicitly Swarm applications
through the platform registration command and existing builder. Each declares a
1 GiB memory limit (64 MiB scheduler reservation) and 0.25 CPU. The host's
application budget is 2 GiB, with the existing HTTP applications already charged,
so one contender fits and both do not. This tests declared-limit admission,
separately from actual host memory use or Docker's scheduler reservations.

The observer submits both stable UUIDs concurrently, waits for one candidate
container creation and one still-prepared capacity waiter, kills/restarts the
existing coordinator, and requires one verified winner and one never-started
waiter failing at its original 90-second admission deadline. It records the
pre-interruption deadline, checks that replay retains both receipts' immutable
plans/deadlines, requires exactly one winner Start and zero loser service or
container objects, and refuses a held or unexpectedly promoted waiter.

An existing B application receives 20 requests/s throughout a 30-second baseline,
competition/restart/expiry and at least 30 seconds after convergence. All those
requests must succeed and identify B, with no retries or timeout changes.
Per-request data, live Docker events, public projections, VM CPU/memory samples,
clock gates and exact source identities are retained as `.admission-race.json`,
`.admission-race.tar`, `.admission-race.source.json` and
`.admission-race.clock.json`; each contender's exact Git history is exported as
`.admission-left.bundle` or `.admission-right.bundle`. Native acceptance remains
pending. This does not complete remove-versus-deploy or bounded ENOSPC testing.

### Bounded lifecycle filesystem ENOSPC

`lifecycle-enospc.yml` builds a no-migration candidate and measures it through the
existing coordinator. The lab stops only that coordinator, copies its opaque
lifecycle metadata with ownership intact onto a new **64 MiB ext4 loopback
filesystem**, bind-mounts that filesystem at its existing lifecycle path, and
restarts it. Original underlying metadata is preserved. Docker-root, registry,
application volumes and registration secrets are outside this fault scope.
The helper refuses paths outside its owned lab-storage prefix, a previously
mounted lifecycle path, more than 16 MiB of existing metadata, or less than
1 GiB of free host storage. No production fault switch or extra daemon is added.

After the normal control endpoint acknowledges a stable request UUID, an
in-container client verifies the public `prepared` checkpoint and immediately
SIGSTOPs the existing coordinator. The observer rejects a missed checkpoint or
any early candidate Create/Start. A UID-1000 filler reaches ENOSPC on the bounded
filesystem; an independent UID-1000 write in the deployer must also return
`ENOSPC`. On resume, journal writes must fail closed with no candidate creation or release
promotion; reads may return the last durable state or be unavailable. After
space restoration the observer kills/restarts the coordinator, and the same
accepted plan, request and admission/operation deadlines must recover, with one
candidate Start after space restoration and eventual certified promotion.

Traffic runs at 20/s, fresh and persistent connections, two-second short timeout
and no retries, starting with a 30-second B baseline before storage setup and
ending after a 30-second stable candidate period. Every request must succeed,
and no candidate may be exposed prematurely. The result, raw requests/events,
public status trace, CPU/memory samples and source/clock identities use the
`.lifecycle-enospc` output prefix. Successful full-lab teardown destroys the VM
and its bounded filesystem; a kept or failed VM retains the mount, image,
original metadata and observer evidence. This tests process recovery from
bounded metadata ENOSPC, not global Docker-root/inode exhaustion, host loss,
backup restoration or application-data durability. Native acceptance is pending.

The filesystem helper alone passed on Ubuntu 24.04 in the fresh disposable
`kayra-fs-smoke-20261114142322` VM using source `c317a15`. Its 64 MiB ext4
filesystem had 57,307,136 available bytes before fill, zero as UID 1000 at
ENOSPC, and 57,307,136 after release. The fixture record and UID ownership
survived all three steps. Exact output is
`/tmp/kayra-fs-smoke-20261114142322.log`; the successful VM was destroyed.
This is helper validation, not integrated coordinator ENOSPC acceptance.

The upgrade lab now retains its detailed raw Ansible/platform log after both
success and failure, including final teardown output on success. Cleanup prints
`raw lab log: /tmp/kayra-upgrade-<vm>.<unique>/lab.log`; the directory is mode
0700 and the log 0600. Successful fleet/VM cleanup no longer deletes the only
copy. Original failed fleets and logs remain preserved as before. These are
local evidence files; they are not published in the package or to a service.

The first integrated OOM attempt at `589a387` reached native rollback and
coordinator certification of B, with one OOM event and 105 failed requests out
of 2,451, then **failed** while collecting unbounded aggregate
`docker service logs` (the command exceeded its 30-second bound). The failed VM
`kayra-candidate-oom-20261114135433`, observer source
`/var/lib/kayra/swarm/candidate-oom-source-s7rqb3dl` and raw evidence remain
preserved. Export: `/tmp/kayra-candidate-oom-failed.tar`; failure summary:
`/tmp/kayra-candidate-oom-failure-summary.json`. A subsequent read-only
`service logs --tail 5` returned immediately. This is not a passing OOM case or
an uninterrupted-rollback result.

The observer now collects bounded logs directly from exact owned service
container IDs, starting at the case's baseline, including the OOM container's
allocation marker. It rejects truncation or missing candidate evidence, and
persists normalized runtime OOM/recovery evidence before later collection
can fail. Traffic, budgets, health, monitoring, discovery and all recovery
criteria are unchanged. A new request/source measurement is required.


The corrected OOM observer at `2763e8c` passed with a new UUID against the
existing coordinator installed from `589a387`. Docker recorded `OOMKilled`,
`rollback_completed`, and certified B recovery 6,975.6 ms after the OOM. There
were 110 failed requests out of 1,844 at 19.9675/s, no premature candidate
exposure, and a 7,429 ms failure-observation window (first failed request start
to last failed response completion, not a claim of continuous outage). Largest
request-start gap: 190.5 ms; minimum host available memory: 3,062,951,936 bytes;
peak sampled CPU busy fraction: 0.4278. This is automatic recovery with
disruption, not uninterrupted rollback. The failed original attempt remains
failed and preserved.

Exact results: `/tmp/kayra-candidate-oom-retry.json`, raw
`/tmp/kayra-candidate-oom-retry.json.tar`, source and clock suffixes, and
`/tmp/kayra-candidate-oom-retry-context.json`. The original failed coordinator
image was retained before subsequent lab rebuild under
`kayra-lab-preserved/deployer:20261114144048` (the exact tag/ID is recorded in
that native-resource workspace's `preserved-coordinator.json`).

The first contender setup was refused by the real builder before the admission
observer ran: copying the fixture changed its app name but left image metadata
in `rollout-complete/web`. The upgrade now sets each contender's own immutable
image namespace, as the existing indexed and Swarm build fixtures already do.
Original bad commits/configuration are retained in
`/tmp/kayra-native-resources-context.json` and its referenced workspace;
`/tmp/kayra-native-admission.log` records the refusal. No admission-race or
integrated ENOSPC pass is claimed from that setup.


The first integrated ENOSPC attempt (observer `c9fd4f8`) reached the bounded
filesystem failure, blocked candidate effects and restored space, then failed
an overly strict observer assertion that control must remain unavailable until
process restart. Per-app envelope calls reopen their journal under the same
exclusive application writer, so safe automatic recovery after space restoration
is permitted. The accepted rollout subsequently converged with its original
identity. This does not turn the failed observer into a pass.

Original raw evidence: `/tmp/kayra-native-enospc-failed.tar`; source:
`/var/lib/kayra/swarm/lifecycle-enospc-source-wwk6uwzc`; bounded filesystem:
`/var/lib/kayra/swarm/lifecycle-storage-xcc5rwnp`. Both remain preserved in the
failed VM. The observer now permits last-durable-state reads while full and
records control availability after space returns, then still explicitly kills
and restarts the owner. ENOSPC proof, zero candidate effects while full,
original plan/UUID/deadlines, one post-restoration Start and zero failed/premature
application requests remain required. A fresh measurement is pending.

### Owned local-volume runtime foundation

`owned-volume.ts` adds a narrow shared identity and runtime port for local named
volumes. The app's durable data owner and each volume allocation are separate
UUIDs; the physical name is derived only from the allocation. A later allocation
gets a different physical name, so a stale creation cannot become the new
allocation's data. The coordinator must persist these identities before effects
and retain them across app removal/recreation. Builder output cannot allocate
physical names. This foundation is not wired into app admission or lifecycle.

The adapter checks exact ownership labels, local driver/scope, empty driver
options and the retained creation receipt. It checks **all containers, including
stopped ones**, and every Swarm service's current and `PreviousSpec` mounts.
Unknown observations refuse deletion. Deletion rechecks ownership and always
uses `force=false`, preserving Docker's own attachment-race refusal. A service
reference blocks even when the volume is currently absent. No prefix-based
adoption/deletion, host mountpoint projection, shell effects or background
controller is introduced. Lifecycle fences, authorization, unresolved creation
outcomes, resource admission and the purge decision remain coordinator work;
these primitives alone do not make purge safe or enable registry GC.

Run the isolated native adapter lab:

```bash
python3 test/lab/swarm-platform/volume-lab.py [--keep] [--output <new-directory>]
```

It creates a unique Ubuntu 24.04 Multipass VM (2 CPUs, 4 GiB, 20 GiB), a lab-only
SSH key and temporary inventory, then uses the existing Docker role. The pinned
Node image supplies a host-side observer binary; no new socket-holding container
is started. A single-node Swarm supplies native attachment observations, with
no application ports published. The lab writes/reads fixture data across
workload recreation, requires stopped-container and zero-replica service/previous
specification purge refusals, clears both specifications before deleting only
the exact owned volume, and verifies another fixture volume's data remains.

Exact source files, a reproducible source archive, versions, image digest,
clock observations, native events and request identities are retained in a
private `.cache/lab-evidence/kayra-volume-lab-<timestamp>/` directory by default.
Successful VMs and temporary keys/sources are removed unless `--keep`; failed
VMs and sources remain with explicit cleanup instructions. Ten mocked-runtime
checks pass. The native pass is recorded below. This is an adapter lab, not proof of
coordinator removal/purge, retained dependencies, SQL safety or application data
retention across rollout/rollback/removal.

The isolated volume adapter lab passed at `e296993` in fresh
`kayra-volume-lab-20261114201749570660`; its successful VM and temporary key were
removed. Native Docker confirmed retained fixture writes across workload
recreation, stopped-container and zero-replica service attachment refusals,
`PreviousSpec` refusal after the first scrub, successful removal only after both
specifications were cleared, and preservation of the unrelated fixture data.
Versions: Engine/CLI 29.9.3, API 1.56, Compose 5.7.1, Node 24.22.1 and the exact
pinned Node digest above. Private source archives, file hashes, source manifest,
clock gates, requests/events and results are retained at
`.cache/lab-evidence/kayra-volume-lab-20261114201749570660/`.
This pass does not enable app volumes or establish coordinator lifecycle/SQL
safety. The fresh full resource-upgrade run uses independent frozen source
`9e6daef`, so it does not include these later volume primitives.

The fresh full resource-upgrade run passed at that frozen source. See
[RESOURCE-RESULTS.md](RESOURCE-RESULTS.md) and
[RESOURCE-RESULTS.json](RESOURCE-RESULTS.json) for measured results, reproduction
and remaining limitations.

### Platform comparison of retained-service inputs

Run the isolated adapter lab with the real immutable registration readers:

```bash
python3 test/lab/swarm-platform/volume-lab.py --platform-inputs
```

The optional observer creates synthetic root-owned generation files with the
platform's exact public/private modes and groups, then drops its child to UID
and GID 1000. It verifies unchanged bound inputs across unrelated configuration
and unused-secret rotation, changed used secrets/configuration, and unavailable
outcomes for missing secrets, wrong modes, mismatched manifests and incorrect
configuration identities. It removes successful synthetic input files before
archiving results. No application secret or SQL engine is involved.

This passed in fresh `kayra-volume-lab-20261114211442363523`, whose successful VM
was destroyed. All frozen tracked source hashes match `98132f8`; the original
context records its pre-commit base, with `commit-source-verification.json`
proving the exact committed content. Private evidence, reproducible source
archive, versions, clock gates, results and SHA-256 manifest are retained in
`.cache/lab-evidence/kayra-platform-inputs-20261114211442/`.
The existing owned-volume native checks passed again in this run.

This is platform materialization/comparison and runtime-adapter evidence. It
does not establish retained dependency reconciliation, managed volume creation
receipts, app-wide rollback, workers, maintenance or coordinator purge safety.
The coordinator receives only comparison outcomes; runtime materialization is a
separate typed port. Native source and result archives remain authoritative.

### Image volume coverage against a real registry

```bash
python3 test/lab/swarm-platform/volume-lab.py --image-admission
```

The optional probe uses the platform-pinned Registry 3.1.2 digest, bound only to
the disposable VM's loopback. It produces a synthetic image declaring `/data`,
pushes it, and verifies exact declared service coverage, uncovered/descendant
mount refusal, one-shot refusal, mixed service/job refusal, unchanged legacy
no-volumes policy, and a plain no-volumes positive control. Container and volume
identities must remain unchanged during admission. This is metadata inspection,
not a managed rollout or evidence of volume creation/data safety.

The corrected probe passed at exact source `e11947b` in fresh
`kayra-volume-lab-20261114214000422632`; the successful VM was destroyed. Private
source archives, hashes, raw registry logs, versions, clock gates and results
are retained at `.cache/lab-evidence/kayra-declared-images-retry-20261114214000/`.
The existing owned-volume checks passed again. Root regression checks also
passed: 741 tests passed, 2 skipped; typecheck/build/lint and Ansible/YAML checks
passed.

The first probe failed only at its plain control: Docker's local `RepoDigests`
retained the original multi-platform index digest after a platform-specific
retag/push, but that index was absent in the target registry. Admission correctly
returned unavailable. The fixture now pins the manifest actually served by its
registry tag, checking the response digest against exact bytes before using that
immutable reference. This changes fixture reference discovery, not production
admission. The original failed run remains failed and preserved in stopped
`kayra-volume-lab-20261114213518881406`, with original frozen source, fixture
images and a disk copy of the registry's RAM-backed storage at
`/tmp/kayra-declared-image-failure-preserved/registry-storage`. Raw failure results
and preservation details are retained at
`.cache/lab-evidence/kayra-declared-images-20261114213518/`.

### Durable volume-creation state and native process kills

```bash
python3 test/lab/swarm-platform/volume-lab.py --volume-state
```

The optional probe kills the real creation-controller process after its synced
create intent but before Docker, after native Create acknowledgement, and after
its synced receipt but before acknowledgement. A second writer must be refused
while the child holds its SQLite-backed OS lock. Restart opens the existing
journal, preserves the exact action/allocation/deadline and records observed
creation. All three cases require exactly one native volume Create event.
A separate known-volume deletion must hold without empty recreation; an expired
intent must create nothing. Authorization here is a lab fixture port, not the
indexed deployer's registration/admission fence.

This passed at source `252c63b` in fresh
`kayra-volume-lab-20261114220837342711`; the successful VM was destroyed. All
three kills recovered to recorded creation-ready, with one native Create each
and unchanged deadlines. Missing/expired cases passed. Private exact source
archives, hashes, raw API/event logs, child checkpoints, journal files, clock
gates and results are retained at
`.cache/lab-evidence/kayra-volume-state-retry-20261114220837/`.
The component's 14 focused checks and the full root suite passed (756 passed,
2 skipped), with typecheck/build/lint and Node/Python/Ansible/YAML checks.

The first native run remains failed and preserved in stopped
`kayra-volume-lab-20261114220424504537`, with source
`/tmp/kayra-volume-source-v1tdy_tj` and private evidence at
`.cache/lab-evidence/kayra-volume-state-20261114220424/`. Its first two kills
recovered; its receipt checkpoint child naturally exited on unsettled top-level
await before the intended kill, releasing the lock. The corrected fixture keeps
its checkpoint child alive until SIGKILL. This did not change journal locking.

Creation-ready is historical creation evidence, not current application health
or permission to start workloads. The controller never deletes volumes or
starts consumers. Post-deadline inspection is separately bounded and read-only.
This is isolated component recovery, not indexed admission, retained dependency
or app data-retention/rollback/removal/purge acceptance.

### Platform-owned private application overlay

```bash
python3 test/lab/swarm-platform/volume-lab.py --app-overlay
```

Platform policy selects an incarnation-scoped overlay from operator registration
and host authority. A runtime port creates it under fixed overlay policy and
normalizes observations. It refuses foreign or duplicate matching names and has
no prune/delete or workload orchestration operation. A stored grant pins its
physical ID; missing or replaced infrastructure is refused without recreation.
Only HTTP service plans reference the separate routing overlay. Retained
services therefore do not pin HTTP routing infrastructure they never use.

Fresh native acceptance passed at `c1ad6e6` in
`kayra-volume-lab-20261115013611178943`; the successful VM was destroyed. The
probe verified distinct private/routing IDs, repeated provisioning without a
second Create, an attachable container on the exact granted ID, missing-grant
refusal without recreation, and foreign ownership refusal. Exact sources,
clock gates, raw network snapshots/API identities, versions and results are in
`.cache/lab-evidence/kayra-app-overlay-retry-20261115013611/` with a SHA-256
manifest. Full root checks passed (767 passed, 2 skipped), as did typecheck,
build, lint and Node/Python/Ansible/YAML checks.

The first native run remains failed in stopped
`kayra-volume-lab-20261114223125150255`, with frozen source at
`/tmp/kayra-volume-source-2jwxx6x7` and private evidence at
`.cache/lab-evidence/kayra-app-overlay-20261114223125/`. Its immediate read after
Create acknowledgement did not establish a grant; later exact-scope reads were
owned. The original transient raw response was not captured, so its exact field
cannot be identified retrospectively. The corrected probe records raw network
snapshots. Platform policy now reconciles post-create observations under one
original absolute deadline and elapsed-time bound, without another Create or
weaker ownership validation. A hung/late observer cannot renew authority.

This is isolated platform-policy/runtime evidence. Registration publication,
durable grant storage, richer service rendering, group admission and lifecycle
cleanup are not enabled by this helper.

### Durable platform overlay recovery

```bash
python3 test/lab/swarm-platform/volume-lab.py --app-overlay-state
```

This optional isolated probe kills the allocation process after synchronized
intent, after native network-create acknowledgement, and after synchronized
physical-grant receipt. It verifies the exclusive writer lock before each kill,
reopens the same state, and requires the original operation identity and absolute
deadline. A Docker network-event stream starts before effects and must show one
create for each recovered physical ID. Removing a recorded empty fixture network
must block further provisioning without recreation. Raw journals, events and API
request identities accompany the JSON summary. Lifecycle authorization is a
fixture port; this does not establish full registration publication, workload
admission or removal acceptance.

The 2026-11-15 run at source `ade46bd` passed all three real SIGKILL cuts on
Engine 29.9.3 / API 1.56 and Node 24.22.1. Each physical network had one live
Create event; operation identities and absolute deadlines survived restart.
Recorded-network deletion was refused without recreation. VM
`kayra-volume-lab-20261115113422548241` was destroyed after success. Private raw
journals, request/event logs, clock checks, source hashes and summary are retained
under `.cache/lab-evidence/kayra-volume-lab-20261115113422548241/` with a SHA-256
manifest. Later registered-record-loss guards have local regression coverage;
the native probe exercises the allocation component, not that registration seam.

### Native adapter command acknowledgements

The native adapter probe accepts `acknowledged` or `uncertain` for a dispatched
write, then requires the exact action, effect and plan to be observed with its
required postconditions before the original action deadline. It never retries
the write. Stale-version rejection assertions remain strict. Request status and
duration metadata accompany both success and failure, without request bodies or
resolved environment values.

The full upgrade attempt `kayra-infra-upgrade-20261115114517` at `f7b3149`
passed baseline Compose upgrade, TLS/auth, caching, policy, restore, rollback,
GC, polling and mixed discovery before its native adapter fixture failed on an
`uncertain` removal acknowledgement. The preserved service snapshot contains the
requested action-5 removal tombstone; Docker also logged an out-of-sequence
update response. The original raw API response was not captured, so the exact
client uncertainty cause is not established. This run did not reach the new
registration handoff and is not a passing acceptance result. The VM, fleet and
frozen source are preserved, the VM is stopped after confirming no active runs,
and private raw evidence is under
`.cache/lab-evidence/kayra-infra-upgrade-20261115114517/` with a SHA-256 manifest.


The `--image-admission` probe also publishes two fixture OCI indexes referring to
one native manifest, then checks that the read-only resolver preserves distinct
source identities while returning the same selected pull digest. These fixture
registry writes occur outside the admission adapter. No Docker workload or
volume may be allocated during inspection. This is registry metadata evidence,
not acceptance of retained database rollouts.


The 2026-11-15 resolver run at `f9529d8` passed the declared-volume and one-shot
checks plus two real OCI index publications resolving to the same native
manifest. Inspection allocated no containers or volumes. Successful VM
`kayra-volume-lab-20261115122751241212` was destroyed. Private raw registry logs,
selected/source image pins, exact versions, clock checks and source hashes are
retained under
`.cache/lab-evidence/kayra-volume-lab-20261115122751241212/` with a SHA-256 manifest.
This does not establish managed workload or retained database rollout acceptance.


The next full upgrade attempt, `kayra-infra-upgrade-20261115120807` at
`fda9e27`, passed the native adapter and preceding Swarm component suite, then
found a platform integration bug during initial Swarm registration. The new
platform-state path lacked a persistent deployer bind mount; UID 1000 could not
write the container's root-owned `/opt/platform` parent (`EACCES`). Compose
indexed registration/build/restart had already passed. This remains a failed
acceptance run. Its VM, fleet, frozen source and raw evidence are preserved; the
VM is stopped after confirming no active runs. Evidence is under
`.cache/lab-evidence/kayra-infra-upgrade-20261115120807/` with a SHA-256 manifest.

The corrected setup provisions a private UID/GID-1000 `0700` host directory and
mounts it only in the existing deployer. The lab requires that exact writable
bind and verifies the same physical grant after replacing the deployer
container. Platform namespace entries are synchronized before effect intent.
The builder gets no platform-state mount, Docker access or application secrets.


### Native managed workload storage probe

```bash
python3 test/lab/swarm-platform/volume-lab.py --managed-service
```

This includes the real registry inspection fixture, then starts a retained
service on an owned local volume and a private overlay. It verifies exact native
specification/ownership, refuses an ordinary retained update, drains and scrubs
the old service to an empty name barrier, and rejects a delayed old create.
A distinct fixture incarnation then uses the same creation receipt and must read
the retained write before incrementing its own start counter. A live Docker
container-event stream must show one start for each service. This is fixture
authorization/rebinding; it does not establish indexed lifecycle removal,
recreation, resource admission or multi-service rollout correctness.


The 2026-11-15 run at `9a60093` passed on Engine 29.9.3 / API 1.56 and Node
24.22.1. Each fixture incarnation had one live container Start event; the old
name barrier refused a delayed create, ordinary retained replacement performed
no native write, and the reused volume kept its original receipt and start
counter data. Successful VM `kayra-volume-lab-20261115132425426016` was destroyed.
Private native specs, request/event traces, data receipt, clock checks and exact
source/version evidence are under
`.cache/lab-evidence/kayra-volume-lab-20261115132425426016/` with a SHA-256 manifest.
This remains fixture authorization/rebinding rather than indexed lifecycle or
application group rollout acceptance.

The fresh 2026-11-15 full upgrade at `1e32190` passed registration/private grant
publication and deployer recreation, alongside existing TLS/Authelia, Compose,
HTTP/migration/resource and health paths. The successful VM was destroyed.
[INFRASTRUCTURE-RESULTS.md](./INFRASTRUCTURE-RESULTS.md) and its JSON companion
record exact scope and measurements. This earlier source does not cover the
subsequent managed runtime, admission or migration-binding changes; managed
group execution remains disabled.

The 2026-11-15 native run at `bcf7f74` also exercised retained creation through
the group-owned service execution slot. Reopening its journal after dispatch
observed the original workload, preserved its deadline/action, and issued no
additional service create. The original service had one live container Start
event. Retained update refusal, the old name barrier and fixture data reuse also
passed. Successful VM `kayra-volume-lab-20261115141010934467` was destroyed;
private evidence and SHA-256 manifest are in its `.cache/lab-evidence/` directory.
This was a journal reopen with fixture authorization, not a SIGKILL or indexed
managed-group lifecycle/admission acceptance run.

The first native barrier run, `kayra-volume-lab-20261115142040482277` at
`7e505bd`, failed before a removal write: the coordinator supplied a full action
to a strict scope-only observation port. The adapter refused that shape and the
operation held. This exposed a coordinator integration bug, not a successful
barrier run. A regression assertion now checks the exact scope keys. Raw results,
native snapshots and the fixture registry's RAM-only state are archived privately
with source hashes and a SHA-256 manifest. The failed VM and frozen source remain
preserved; the VM is stopped after checking for active observers/coordinators.

The fresh corrected run at `64742ec` passed the managed barrier's removal,
draining, journal reopen and scrubbing under its original deadline. The old
service name fenced a delayed create; both fixture incarnations had one Start
event and retained data matched its receipt. Successful VM
`kayra-volume-lab-20261115142459792209` was destroyed. Its private source, clock,
request/event/spec and journal evidence has a SHA-256 manifest. This remains
fixture authorization and journal reopen, not indexed group/SIGKILL acceptance.

The 2026-11-15 run at `9fdcc2b` passed explicit unchanged retained reactivation
through the durable service slot after scrubbing. Journal reopen preserved its
original action/deadline, physical service identity and volume creation receipt;
the retained counter advanced once. A changed spec and ordinary replacement
were refused. After another scrub, a distinct fixture incarnation read that data
and advanced the counter again. Live starts were exactly two for the original
service (initial creation and explicit reactivation) and one for the new service.
Successful VM `kayra-volume-lab-20261115143520813152` was destroyed. Private raw
source/clock/request/event/journal evidence has a SHA-256 manifest. Authorization
and rebinding remain fixture-owned: this does not establish indexed cancellation,
retry, migration or group rollout acceptance.

### Native retained-startup and migration parent

```bash
python3 test/lab/swarm-platform/volume-lab.py --managed-group
```

This includes the managed-service/storage probes, then allocates a distinct
fixture incarnation and owned volume. The rolling preparation parent must start
its retained app-owned HTTP ledger, wait for readiness, and run a declared
one-shot migration through the private `db` DNS alias. Input materialization is
inside the fixture composition port. Reopening the parent journal after migration
Start must preserve deadlines, observe one execution and retain one ledger entry.
The fixture then starts its forbidden-overlap worker, reopens the consumer
journal after update acknowledgement, preserves the original deadline and verifies
that the worker uses only the private application overlay. A live container-event
stream records dependency, job and worker starts. This tests fixture-authorized
components: indexed admission, SIGKILL, HTTP continuity, release promotion, SQL
safety and full group lifecycle are not established.

The first native group-preparation run at `5c78d69`, VM
`kayra-volume-lab-20261115150506587649`, held at its original startup deadline
before any migration. Its retained service was healthy, but Docker omitted the
empty environment array and the adapter's desired-spec comparison rejected that
harmless default. The shared matcher now accepts omitted/null empty arrays while
retaining exact nonempty arrays; a regression also rejects undeclared environment
entries. This failed run is preserved with native service/container snapshots,
journals, registry RAM contents and a SHA-256 manifest. The VM is stopped after
archiving RAM state and confirming no active observer/coordinator.

The corrected native group run at `2bdbcdf` passed retained startup and its
private-DNS migration after reopening the parent journal. The live event stream
recorded one dependency start and one migration start; the retained ledger held
one stable operation ID. Startup/migration deadlines survived reopen, and the
journal held no materialized secret value. Successful VM
`kayra-volume-lab-20261115185513728940` was destroyed. Private exact-source,
clock, API/event, receipt and journal evidence has a SHA-256 manifest. This is
fixture-authorized preparation with an HTTP ledger, not indexed admission,
SIGKILL, SQL or complete group rollout acceptance.

The consumer fixture's first run at `277edf3`, VM
`kayra-volume-lab-20261115202224217427`, failed before worker intent because its
new journal parent directory had not been created. Its native results, live event
stream, journals, service/container snapshots and registry RAM were archived with
a SHA-256 manifest; the VM is stopped and preserved. No worker guarantee follows
from that failed run.

After correcting the directory setup, the fresh run at imported implementation
`5f170ca`, VM `kayra-volume-lab-20261115202625127963`, passed. Live events showed
one retained dependency start, one migration start and one worker start. Both
parent journals reopened without duplicate execution or deadline renewal; the
worker joined only the private app overlay, and neither journal contained the
materialized synthetic secret. The successful VM was destroyed. Private evidence
includes the exact frozen file manifest and archive (including an unused work in
progress compensation module), API requests, events, journals and clock checks,
with a SHA-256 manifest. This establishes fixture-authorized component behavior,
not indexed admission, SIGKILL, HTTP continuity or full application recovery.

The current managed group fixture also performs a bounded worker compensation
probe after startup. It updates the worker to a candidate, records restore intent,
injects interruption before that restore reaches the transport, and reopens the
journal. Recovery must use a metadata-only CAS fence without changing the running
task, then verify a new restore identity against the immutable previous context.
Live events must show exactly the initial, candidate and restored worker starts;
no capacity release, indexed admission, HTTP continuity or whole-application
compensation is established by this component probe.

The native compensation probe at `79569f6` passed in fresh VM
`kayra-volume-lab-20261115210411279754`, which was destroyed. The live event stream
recorded exactly three worker starts (initial, candidate, restored), one dependency
start and one migration start. After injected interruption before restore
transport, reopening preserved the original recovery deadline, a metadata fence
preserved the running task identity, and restore attempt 2 converged beyond the
pending versions. No materialized synthetic secret was in the journals. Private
exact-source, API/event, clock and journal evidence has a SHA-256 manifest. This
is a fixture-authorized injected interruption, not SIGKILL, indexed admission,
whole-application recovery or HTTP continuity acceptance.

The whole-group fixture then adds a new worker and a new retained helper under
another recorded operation, drives retained preparation and consumer convergence,
and compensates the group to its previous immutable plan. The group recovery
journal reopens after restore acknowledgement. Verification requires unchanged
recovery deadlines, restored worker convergence, unchanged existing dependency,
and fully scrubbed zero-replica barriers for both new-only services. Fixture grants
do not establish indexed resource admission or release promotion. HTTP continuity,
SQL safety, SIGKILL and maintenance/check integration remain separate acceptance.

Whole-group recovery at `a01a284` passed in fresh VM
`kayra-volume-lab-20261115212423366099`, which was destroyed. After converging a
candidate with a new worker and retained helper, reopening the recovery journal
after restore acknowledgement preserved its deadline and reached `verified`.
Both new-only services were fully scrubbed at zero replicas; the original
retained dependency stayed running. Live events recorded five original-worker
starts across both candidate/restore pairs, one dependency start and one migration
start. Private exact-source, API/events/clock/journal evidence has a SHA-256
manifest. This fixture-authorized component probe still does not establish indexed
admission, active-release publication, HTTP continuity, SIGKILL, SQL safety or
maintenance/check integration.

The managed-group fixture also probes declared checks through Docker Exec inside
its admitted app inspector and worker containers. The inspector is a declared
long-running app service with a read-only owned mount; the worker check uses its
inherited granted environment. Retained dependencies are not check targets. Exec receives
only the stable check operation identity, with no privilege expansion, attachment,
or output capture. Reopening after acknowledged Start must preserve the execution
deadline and retain known exit status. A deliberately lost acknowledgement for a
fast check must hold as `unknown-start`, despite stopped/exit-zero inspection, and
the live event stream must show exactly one Start for each recorded exec ID.
This component probe does not enable checks or singleton handoffs in normal
managed execution; held/expired checks do not imply the process was stopped.

Exec request/inspection fields follow the [Docker Engine API v1.56 reference](https://docs.docker.com/reference/api/engine/version/v1.56/).

The first check probe at `3df34e1`, VM
`kayra-volume-lab-20261115224419669696`, stopped before check selection/Exec because
its fixture incorrectly declared a check on a retained dependency. The contract
correctly refused that target. The corrected fixture declares an app inspector
with a read-only owned mount. The failed VM is stopped and preserved with frozen
source, native results/journals/events/API evidence, process/container snapshots,
and a verified registry RAM archive, all covered by a SHA-256 manifest. An extra
service-inspect JSON snapshot is missing: cleanup validation rejected truncated
service IDs, and its shell still proceeded to stop the VM. The disk retains
Docker state. Subsequent cleanup separates successful archive verification from
VM stopping. No native check guarantee follows from this failed run.

The next check run at `481d7c3`, VM
`kayra-volume-lab-20261115225406948642`, found that Engine 29.9.3 reports a newly
created exec with `Running: false` and `ExitCode: null`. The adapter incorrectly
classified that as unavailable, and the fixture assumed Start after two ticks.
No check started. The adapter now accepts nullable exit status, and the fixture
waits for explicit Start intent/acknowledgement. A regression retains both null
and zero initial-state handling without interpreting either as execution proof.
The failed VM is stopped and preserved after separately verifying its results,
journals/events/API, registry RAM, service/container/process snapshots and native
initial ExecInspect response. Private evidence has a SHA-256 manifest.

The corrected check run at `7c66556`, VM
`kayra-volume-lab-20261115230808817172`, passed and the VM was destroyed. After
journal reopening, the declared app inspector verified its existing read-only
owned mount and the worker verified its inherited granted environment and stable
check identity. Both checks retained known exit zero and their original execution
deadlines. A fast check whose Start acknowledgement was deliberately hidden held
as `unknown-start`; it was not repeated or misclassified as successful. The live
event stream recorded one Start per check exec ID. Private exact-source,
API/events/clock/journal evidence has a SHA-256 manifest. Normal check/singleton
integration, indexed admission, active-release publication and SIGKILL acceptance
remain pending. Unknown or running checks require the pinned container to be
fenced before lifecycle settlement; service metadata fences alone cannot settle
an Exec Start.

Managed application verification now has a separate private owner after native
consumer convergence or group compensation. Its immutable source includes every
consumer and retained dependency, the exact application plan, and recovery input
when restoring a previous release. Check deadlines derive from the recorded
convergence time; reopening cannot restart the phase window. Recovery checks use
a distinct stable identity. Only known successful checks followed by current
workload and routed readiness can produce a verification certificate; a check
from a replaced task is refused. A certificate does not itself publish an active
release or settle admission. These parent semantics currently have journal-backed
unit coverage; indexed wiring and native parent verification remain pending.

Rolling preparation, consumer convergence and compensation accept check-bearing
plans only when the composition supplies a concrete check runtime. A healthy
coordinated singleton remains unverified until its app-declared completion check
passes; native readiness is not leadership evidence. Missing capability refuses
before intent and effects. Normal indexed managed execution remains gated.

The next native component probe starts a fresh singleton scope whose application
uses an owned-volume exclusive file lock and logs acquisition, effect, release
and standby events. Kayra never reads or changes that lock. The probe verifies A,
updates to a healthy B with a deliberately failed completion check, restores A,
and runs the previous release's completion check under a distinct recovery
identity. The app history must show A/B/A acquisition and no effects outside its
recorded owner interval. This demonstrates graceful app-owned handoff only;
lease expiry, hard kills, exactly-once behavior and indexed promotion are not
established by the fixture.


The first checked-singleton run at `a1ebee0`, VM
`kayra-volume-lab-20261116001145341206`, stopped before workload creation:
the fixture incorrectly set its health timeout above its interval. Its results,
live events, service/container snapshots and registry RAM were archived before
stopping the preserved VM. The fixture's health timing and JSONL newline were
corrected; no runtime validation was relaxed.

The fresh run at `0cd5c69`, VM `kayra-volume-lab-20261116003916616088`, passed
and the VM was destroyed. Reproduce with
`python3 test/lab/swarm-platform/volume-lab.py --managed-group`.
The real preparation, consumer, completion-check and compensation owners drove
an app-coordinated singleton from A to B and back to A. B became healthy on
standby, then its declared failing completion check prevented verification.
Recovery restored A and passed its app-declared active-owner check using a
distinct recovery operation identity. Application history recorded acquisitions
A/B/A and 578 effects, each inside its recorded owner's interval. Private raw
API/events/journals/history and exact source/version evidence have a SHA-256
manifest. This proves graceful application-owned locking in this fixture;
indexed promotion, crash-safe leases, hard termination and exactly-once effects
remain unproven. Normal managed V3 deployment remains disabled.

The maintenance probe is included by `volume-lab.py --managed-group`. It runs a
private worker against an app-owned schema/effect ledger, stops the old worker,
runs a replay-safe migration, starts the new worker and verifies native readiness.
It reopens preparation and consumer journals; live Docker events identify the
migration container and require exactly one Start in this uninjected run.

At `e9fd197`, VM `kayra-volume-lab-20261116191150950512` found a fixture command
that repeated its declared Node entrypoint. The migration exited 1 and the
operation held; its VM, frozen source, registry RAM and raw evidence are preserved.
The command was corrected in `ca27f92`.

The next VM, `kayra-volume-lab-20261116191818612568`, exposed a runtime ordering
bug: Swarm's terminal task state preceded actual container cessation. The
quiescence certificate was issued at `1794857022345` ms; migration applied at
`1794857023567` ms; the old container stopped at `1794857024168` ms. Three old
worker requests encountered the new schema. This is a failed maintenance case.
Its source was `ca27f92` plus the admission changes subsequently committed in
`d149382`; the archived source manifest identifies every staged file. This
fixture does not exercise resource admission. All results, the diagnostic ledger,
live events, runtime snapshots and registry RAM were archived before stopping
and preserving the VM and disks.

The fix requires a separate Docker container inventory for zero-replica barriers,
including owned containers absent from Swarm task history. Running, paused,
restarting, created and removing containers block certification. Retained-service
reactivation and check-container cessation use the same barrier evidence. A
check cessation proof establishes neither execution nor migration outcome.
Fresh native maintenance validation is pending; normal managed V3 execution
remains disabled. Active-service convergence also needs its separate container
drain check before this experimental integration can be considered complete.


The fresh drain-fix run at `b06d2de`, VM
`kayra-volume-lab-20261116193350363165`, passed and the VM was destroyed.
Reproduce with `python3 test/lab/swarm-platform/volume-lab.py --managed-group`.
The app-owned ledger reached schema 2 with zero violations, no old-worker effects
after migration, one applied operation identity and one migration Start in the
live Docker stream. Retained native service and volume identity were unchanged.
Preparation and consumer journal reopen preserved original phase deadlines.
The certificate-to-final-verification interval was 3.705 seconds; this excludes
quiescence time and is neither HTTP outage measurement nor a continuity claim.
The singleton/check/compensation component probes in the same run also passed.
Raw API/events/journals/ledger/source/version evidence has a private SHA-256
manifest. This closes the reproduced zero-replica drain bug; active-service
container convergence, indexed lifecycle integration and full acceptance remain
required before normal managed V3 execution can be enabled.


The active-container run at `af7f4e6`, VM
`kayra-volume-lab-20261116194316128522`, passed and the VM was destroyed.
All active container inventories matched their current native tasks. The
singleton application released its lock but delayed each old process's exit
by three seconds; candidate and restoration convergence both followed the old
process's recorded exit marker. Its A/B/A ownership and effect checks passed.
Maintenance again reached schema 2 with zero violations, no old effects after
migration, one applied identity and one live migration Start, preserving retained
service/volume identity and phase deadlines. The request trace remains bounded;
raw requests, events, journals, app history and exact source/version evidence have
a private SHA-256 manifest. These are component fixtures, not indexed admission,
process-kill, SQL, routed HTTP or full-platform acceptance. Normal managed V3
execution remains disabled.


The maintenance probe now uses the connected private lifecycle owner for both
releases, including final verification, atomic active/last-good promotion and
resource settlement. Its isolated fixture resource book is synchronized in a
separate locked journal; this exercises resource-book decisions, not the
platform's shared accounting binding or current-host admission observation.
The probe reopens the lifecycle journal after migration Start and consumer
dispatch and requires the original deadlines, one applied migration identity,
unchanged retained service/volume identity and no old effects after migration.
This is graceful journal reopen, not coordinator SIGKILL acceptance. Fresh native
validation of the connected owner is pending. Failed/unsafe recovery and normal
managed V3 execution remain unavailable.


The connected-owner run at `1674079`, VM
`kayra-volume-lab-20261116211421769730`, passed; the successful VM was destroyed.
Both releases completed through the private lifecycle owner. B's active/last-good
record and target resource settlement survived the journal reopens. The ledger
reached schema 2 with zero violations, no old effects after migration, one
applied operation identity and exactly one live migration Start. Retained service
and owned-volume identities and original deadlines were preserved. The
certificate-to-final-verification interval was 4.541 seconds, excluding
quiescence; this is not an HTTP outage measurement. The delayed-exit singleton
and component compensation/check probes also passed. The bounded trace contains
16,438 API requests. Raw logs, journals, ledger, live events, exact source and
versions are retained privately with a SHA-256 manifest.

This run used Engine/CLI 29.10.0 (API 1.57), Compose 5.7.1, Node v24.22.1 and
Ubuntu 24.04.5 ARM64, kernel 6.8.0-147. The exact Node and registry image digests
are in the retained manifest. This proves fixture accounting and successful
owner orchestration, not the shared platform index, SIGKILL, unsafe migration
recovery or normal managed V3 acceptance. The experimental entrypoint stays off.


The managed-group lab also includes an audited-resolution maintenance variant.
Its app migration applies the schema change and deliberately exits 1; its
app-provided probe returns `unknown`. The owner must hold with the old active
record, no new consumers and pending capacity. The fixture operator separately
inspects the application ledger, supplies an applied assertion, reopens the
journal and replays the request. Final convergence must preserve one migration
Start, original deadlines, retained identities and zero old-version effects
after migration. This authorizes only fixture data inspection; Kayra contains
no application ledger or schema interpretation. Fresh native validation is
pending. This is not normal catalog/client integration or automatic recovery
from an irreversible migration.


The audited-resolution run at `65f5b96`, VM
`kayra-volume-lab-20261116212922358296`, passed and was destroyed. Its migration
applied schema 2 but exited 1; the probe returned unknown. The owner held with
A's active record, no B consumers and a pending charge. A fixture operator
inspected the app-owned ledger, recorded applied, reopened and replayed the
receipt, and B completed with target settlement. There was exactly one live
migration Start, zero schema violations, no old effects after migration and
unchanged retained service/volume identity and deadlines. The combined trace
contains 16,971 API requests. Engine/CLI 29.10.0/API 1.57, Compose 5.7.1,
Node v24.22.1 and Ubuntu 24.04.5 ARM64 were recorded with raw events, journals,
ledger and source in a private SHA-256 manifest. The certificate-to-verification
interval was 5.976 seconds; it excludes quiescence and is not HTTP outage data.
This does not establish normal client/index integration or automatic rollback
of irreversible migrations.


Both connected-owner maintenance variants now require a synchronized data
compatibility fence before candidate service or migration Start. Final B is
verified in epoch 1; A was verified in epoch 0. After reopening, an ordinary
historical restore to A and the same old plan submitted without its restore
marker must both be refused before a new admission or workload mutation. The
private lifecycle journal is format 2; pre-fence V3 experimental journals are
not silently upgraded. Fresh native validation of this guard is pending.


The compatibility run at `1cdfa03`, VM
`kayra-volume-lab-20261116214230463380`, passed and was destroyed. Both maintenance
variants observed the synchronized epoch before candidate service/migration
Start, finalized B in epoch 1, and refused historical and disguised A restores
from epoch 0 after reopening. Each migration started exactly once in the live
stream; schemas, retained identities and deadlines were preserved with zero
violations. Logs, journals, source, requests, versions and live events are
retained privately with a SHA-256 manifest. This establishes neither normal
indexed deployment nor compatibility preservation through managed removal.


The singleton fixture now runs A, failed B and restored A through the connected
private lifecycle owner, including bound fixture resource accounting. It reopens
after recovery intent and native restoration acknowledgement, requires the
previous release's distinct completion check before atomic promotion, loses a
previous-budget settlement acknowledgement, then reconstructs settlement after
another reopen. Its app-owned lock/history and delayed old-process exit checks
remain unchanged. The journal is private format 3. Fresh native validation is
pending; this is not shared platform-index, SIGKILL, HTTP continuity or host-loss
acceptance, and the normal managed V3 entrypoint remains off.


The first connected-rollback run at `5ca9ffe`, VM
`kayra-volume-lab-20261117214205898000`, completed singleton recovery (597 effects)
but failed the later maintenance-fixture assertion because that fixture lacked
the newly required metadata-fence port. The owner refused safely before the
expected compatibility check. Frozen source, raw results/events, full service
snapshots and registry RAM were archived and hashed before stopping and
preserving the VM and disks. The fixture port was wired in `5d7ab57`.

The fresh run at `5d7ab57`, VM `kayra-volume-lab-20261117220849347075`, passed and
was destroyed. Its connected singleton recorded A/B/A ownership with 614 effects,
reopened after restoration acknowledgement, verified A's distinct completion
check, atomically promoted the restored record and reconstructed a lost
previous-budget settlement acknowledgement. Both delayed process-exit checks,
maintenance variants, migration audit/replay and old-epoch restore refusals
passed. The trace contains 15,657 API requests. Engine/CLI 29.10.0/API 1.57,
Compose 5.7.1, Node v24.22.1 and Ubuntu 24.04.5 ARM64 plus raw source, events,
journals, histories and versions are retained privately with a SHA-256 manifest.
These remain isolated owner fixtures, not shared-index, SIGKILL, routed HTTP
or full-platform acceptance. Normal managed V3 is still disabled.


The initial-cleanup variant now starts a first app with a known irreversible
schema migration and a deliberately failing completion check. It requires no
verified active release, stopped/scrubbed workload evidence, absent resource
settlement and the preserved compatibility epoch. A separate explicit deployment
then reactivates the unchanged database and starts compatible workers without
rerunning the migration. The app-owned ledger must retain schema 2, its one
original operation, zero violations and the original volume receipt/native DB
identity. This tests private cleanup/reactivation, not indexed removal/purge,
SQL, unknown-check cleanup or SIGKILL acceptance.

The fresh run at `2a6b995`, VM `kayra-volume-lab-20261117224831800875`,
passed and was destroyed. The initial unsafe migration applied schema 2 once;
cleanup and explicit retry preserved the database native identity, volume receipt
and original migration operation with zero app-ledger violations. The complete
singleton/maintenance/audited-recovery group also passed (16,833 API requests).
Engine/CLI 29.10.0/API 1.57, Compose 5.7.1, Node v24.22.1 and Ubuntu
24.04.5 ARM64 were recorded with private raw artifacts and SHA-256 manifests.

The singleton fixture additionally exercises unreserved and reserved cancellation
before any workload intent, reopens across the settlement boundary and loses one
accounting acknowledgement. It requires an unchanged verified release, native
service version and task identities. The fresh cancellation run at `ec0c5a9`, VM
`kayra-volume-lab-20261117230954810005`, passed and was destroyed. Both cancellation
orderings and lost-accounting-acknowledgement recovery preserved the live service
version/tasks and verified active pointer. The complete singleton/maintenance/
initial-cleanup group passed; singleton A/B/A recorded 678 effects. Engine/CLI
29.10.0/API 1.57, **Compose 5.8.0**, Node v24.22.1 and Ubuntu 24.04.5 ARM64
were recorded; raw artifacts and SHA-256 manifests remain private.


A declared rollback-compatible maintenance variant now retains the app-owned
schema-2 ledger while restoring an A worker whose own code understands that
schema. B deliberately fails its completion check. The root must authenticate
its completed maintenance quiescence certificate, carry every recorded CAS
version, preserve the original recovery deadline across reopen, verify the old
application and settle the previous budget. The ledger must show A/B/A effects,
one migration Start and zero violations. Unsafe maintenance still requires
forward recovery; no down-migration is implemented. The fresh source `8781e91`, VM
`kayra-volume-lab-20261117232033683861`, passed and was destroyed. The compatible
case retained schema 2, one applied operation and the original database native
identity, with A/B/A effects, zero violations and the original recovery deadline.
The full group recorded 21,456 API requests. Engine/CLI 29.10.0/API 1.57,
Compose 5.8.0, Node v24.22.1 and Ubuntu 24.04.5 ARM64 plus raw artifacts and
SHA-256 manifests are retained privately.

The next variant cancels maintenance after a recorded partial stop, before any
preparation intent. It requires restoration of A with schema 1, no B effects,
no fabricated migration evidence, and zero Starts across all 16 possible
migration/probe names for that run. The same compensation implementation uses
the immutable quiescence source and all recorded CAS versions. Unit tests also
hold a stop request until after restoration and require its stale CAS refusal.
Fresh source `dbe7482`, VM
`kayra-volume-lab-20261117233826746281`, passed and was destroyed. Partial-stop
cancellation restored A under the original recovery deadline, with schema 1,
no applied operations, no B effects and zero migration/probe Starts. The full
group recorded 22,792 API requests. Engine/CLI 29.10.0/API 1.57, Compose 5.8.0,
Node v24.22.1 and Ubuntu 24.04.5 ARM64 plus raw artifacts and SHA-256 manifests
are retained privately.

The connected singleton now also owns the existing lifecycle envelope: each
run references a retained immutable source and the shared deployment ticket,
and only its synchronized complete root snapshot releases that gate. Reopening
includes both journals. Runs 2–5 must remain bound to that one action sequence,
including rollback and both unstarted cancellations. Accounting remains an
isolated fixture book; this is not the platform-wide index binding or normal
operator dispatch. Fresh source `54fd48e`, VM
`kayra-volume-lab-20261117235827976627`, passed and was destroyed. Its four
requests retained one action sequence through journal reopen, rollback and both
unstarted cancellations; singleton A/B/A recorded 601 effects. The whole group
recorded 21,378 API requests. Engine/CLI 29.10.0/API 1.57, Compose 5.8.0,
Node v24.22.1 and Ubuntu 24.04.5 ARM64 plus private raw/SHA-256 evidence were
retained.

The singleton fixture now uses the filesystem app index itself: explicit new-app
managed protocol, indexed registration/data owner/volume identities, retained
fixture build receipts, the existing global resource book and a real normalized
host observation. Lost previous-budget and unstarted-settlement replies are
injected after durable writes to that index. Reopening the index must reconstruct
the same pending run, original deadlines and shared action sequence. Fixture
build/grant callbacks remain; this does not cover public builder/control dispatch,
SQL, real process kills or full-platform acceptance. Fresh validation of this
indexed variant is pending.

The pinned Node runtime image pull in the volume lab permits three provisioning
retries, five seconds apart, for transient registry connection failures. This
occurs before runtime probes or workloads start; it adds no application-request
retry or deployment-effect retry. Failed provisioning labs remain preserved.

For a network path that stalls Docker registry downloads at the default MTU,
`python3 test/lab/swarm-platform/volume-lab.py --managed-group --egress-mtu 1280`
sets only the disposable VM's default-route interface MTU. The requested value is
recorded in `context.json`. The Docker role, daemon TLS defaults, host network,
other VMs and host Docker context are unchanged. This is a lab network parameter,
not a Kayra fleet setting or an application rollout retry.

On 2026-11-18, source `f83c107` passed the managed-group lab in fresh VM
`kayra-volume-lab-20261118114837348248`, created with `--managed-group
--egress-mtu 1280`. The harness destroyed it after fetching the results. The
local evidence directory contains raw events/API observations, source manifests,
results and a verified SHA256SUMS file. Engine/CLI 29.10.0, API 1.57, Compose
5.8.0, Node 24.22.1, Ubuntu 24.04.5 ARM64 and kernel 6.8.0-147-generic were
recorded. The pinned Node and registry images remain the harness constants.

The group recorded 22,030 observation requests. Its singleton probe used the
actual filesystem app index and shared accounting writer, prepared fixture build
receipts and grant callbacks. It recorded 683 A/B/A effects with app-owned
leadership checks, automatic compensation, lost settlement acknowledgements and
unchanged native tasks/versions for reserved and unreserved cancellation.
Status and fresh health projections passed after initial deployment, a failed
candidate check, restored release promotion and later unstarted cancellations.
A healthy failed-check candidate remained distinct from the historically
certified active release. Other group probes retain their explicitly private
component scope; this is not public builder/CLI, HTTP continuity, TLS/Authelia,
SIGKILL or full platform acceptance.

Three earlier bootstrap attempts were preserved after registry network timeouts,
before any workload started. In the last disposable failed VM, reducing its
default-route interface MTU to 1280 permitted the same pinned download after
restoring Docker TLS defaults. That diagnostic VM was stopped after evidence
was archived and hashed. The fresh passing VM used the explicit MTU option from
creation; this did not change host/other-VM networking or rollout criteria.

The subsequent reporting-capability extraction, source `cbe0f4c`, also passed
the same fresh native command on 2026-11-18 in
`kayra-volume-lab-20261118120753175175`. The group recorded 21,053 API
observations and verified managed status/health, shared indexed accounting,
rollback and later cancellation with the narrower read ports. The successful
VM was destroyed, and raw source/results/events plus verified SHA256SUMS were
archived. Versions, image pins and explicit egress MTU 1280 were unchanged from
the preceding run. This retains the same fixture/pipeline scope limitations.

Source `eb1e115` passed the composed-workload managed-group run on 2026-11-18
in fresh VM `kayra-volume-lab-20261118123920730861` with explicit egress MTU
1280. Its group recorded 21,384 observations, and the actual-index singleton
recorded 650 A/B/A effects through the composition factory, retaining its
rollback, lost acknowledgement, status/health and cancellation assertions.
The successful VM was destroyed after evidence collection. Raw source, events,
results and logs have verified SHA256SUMS; exact versions stayed Engine/CLI
29.10.0, API 1.57, Compose 5.8.0, Node 24.22.1, Ubuntu 24.04.5 ARM64 and kernel
6.8.0-147-generic. Recorded receipts and permission remain explicit fixture
callbacks, not the normal platform deployment pipeline.

The volume-state probe additionally covers a real SIGKILL immediately after
late receipt metadata is synchronized. It advances only the fixture's logical
creation clock after a real Create whose acknowledgement is lost; it never
changes the VM clock. The original creation attempt stays held with its original
deadline. A restarted metadata observer retains the same creation receipt and
issues no further Create, checked in both live volume events and raw API request
counts. Reproduce with `volume-lab.py --volume-state --managed-group
--egress-mtu 1280`. This metadata probe does not establish application-job or
normal indexed volume-catalog acceptance.

Source `f07528b` passed `--volume-state --managed-group --egress-mtu 1280`
on 2026-11-18 in fresh VM `kayra-volume-lab-20261118135124619060`. The
late-receipt case survived real SIGKILL after metadata replacement, retained
its held state and original deadline, and recorded exactly one native creation.
Five total Create API requests matched the probe's expected total. The group
recorded 20,645 observations and 639 singleton effects. The successful VM was
destroyed after collection; raw evidence/source and verified SHA256SUMS are
retained. Exact versions stayed Engine/CLI 29.10.0, API 1.57, Compose 5.8.0,
Node 24.22.1, Ubuntu 24.04.5 ARM64 and kernel 6.8.0-147-generic. The logical
clock scope above still applies; this is not full indexed allocation acceptance.

Source `5c3815b` passed `--volume-state --managed-group --egress-mtu 1280`
in fresh VM `kayra-volume-lab-20261118140349392676` on 2026-11-18. The actual
index singleton consumed the deployment-owned recorded receipt reader after
reopening its creation journal, recording 647 A/B/A effects; the group recorded
21,112 observations. Volume-state assertions also passed. The successful VM
was destroyed; archived raw evidence and frozen source have verified SHA256SUMS.
Versions and image pins were unchanged from the preceding run. Volume creation
remained explicitly authorized fixture preparation before indexed admission.

The singleton now uses the allocation catalog rather than an individual creator.
It checks one native Create across A/B/A replacement, recovery and cancellation,
then prepares another operation against the same registered allocation and
requires the original birth and unchanged catalog. Receipt availability is
checked independently by the runtime. This is still fixture-authorized creation,
not acceptance of the normal coordinator's admitted allocation lifecycle.

The singleton's next integration uses private lifecycle source version 2 and the
coordinator's `allocating` phase. No volume Create occurs during fixture setup.
After shared admission, the catalog receives the parent's fresh permission;
the first native Create deliberately loses its acknowledgement. The observer
reopens both journals while allocation is pending, retains the original deadline
and requires exactly one Create through A/B/A and cancellation. Platform inputs
and catalog-journal storage still use fixture wiring; this does not establish
normal public registration/deployment/removal integration.

Catalog source `540c6d5` passed `--volume-state --managed-group --egress-mtu
1280` in fresh VM `kayra-volume-lab-20261118145213186061` on 2026-11-18.
The group recorded 21,699 observations and its singleton recorded 696 A/B/A
effects with exactly one Create. Catalog birth reuse and journal reopen checks
passed. Successful cleanup destroyed the VM; raw source/results/events are
archived with verified SHA256SUMS. Exact versions remained Engine/CLI 29.10.0,
API 1.57, Compose 5.8.0, Node 24.22.1, Ubuntu 24.04.5 ARM64 and kernel
6.8.0-147-generic. This source preceded the admitted allocation phase above.

The singleton can now use the index-owned catalog capability and workload factory.
The index creates storage during new application initialization, opens it strictly
as existing during deployment, and gives materialization a receipt-only port.
The fixture supplies native volume effects and platform input/grant callbacks;
it no longer opens or repairs the catalog journal itself. The same lost-Create
acknowledgement and A/B/A assertions remain required.

Admitted-allocation source `3e1cd6b` passed `--volume-state --managed-group
--egress-mtu 1280` in fresh VM `kayra-volume-lab-20261118150412049672` on
2026-11-18. The singleton reopened after the lost Create acknowledgement,
retained the original allocation deadline and recorded one Create across 681
A/B/A effects; the group recorded 19,931 observations. The successful VM was
destroyed and raw source/results/events have verified SHA256SUMS. Versions and
image pins stayed unchanged. This source still used a fixture-owned catalog
journal; index-owned storage is the subsequent revision above.

The next observer check reconstructs A after the lost Create acknowledgement by
starting the managed reconciliation loop against the reopened index. Its runtime
factory checks the accepted run, source identity, allocation requirement and
original deadline before returning fixture inputs. The loop completes A without
further manual ticks, then stops before the existing candidate/rollback fault
steps. This proves scheduling reconstruction in the same lab process, not a
coordinator SIGKILL or public deployment-pipeline guarantee.

Maintenance fixtures now bind the job composition to an immutable run context
when opening or reopening the lifecycle owner. Migration and status-probe Create
use the platform input materializer rather than selecting environment values
inside the native callback. Existing application-ledger, one-Start, recovery and
retained-data assertions remain. The isolated accounting and fixture grant/input
scope is unchanged; this is not normal platform factory acceptance.

Index-owned catalog source `d95aa14` passed in fresh VM
`kayra-volume-lab-20261118151611837056` on 2026-11-18. The singleton recorded
716 A/B/A effects, one Create and successful lost-acknowledgement reconstruction;
the group recorded 21,320 observations. Observer source `3ccc2be` then passed in
fresh VM `kayra-volume-lab-20261118152539312639`: 25 reconstructed input loads,
693 singleton effects, one Create and 20,552 group observations. Both used
`--volume-state --managed-group --egress-mtu 1280`; both successful VMs were
destroyed. Raw source/results/events have verified SHA256SUMS. CLI 29.10.0,
Compose 5.8.0, Node 24.22.1 and pinned images were unchanged. The distinct scope
limitations for catalog ownership and same-process observer restart above apply.

The singleton's subsequent revision assembles workload, job, check, readiness,
host and allocation ports through the managed-runtime composition factory.
Its observer constructs a fresh factory from each validated execution context.
The existing A/B/A, cancellation, Create-count and receipt assertions remain;
current platform input and grant policy still use explicit fixture callbacks.

Job-input source `c28f7b6` passed the fresh native run in VM
`kayra-volume-lab-20261118154107261474` on 2026-11-18. All five maintenance,
resolution, recovery, initial-cleanup and quiescence-abort results reported bound
job composition and zero schema violations; non-abort cases retained schema 2,
and the pre-migration abort retained schema 1. The group recorded 19,264
observations and the singleton recorded 592 effects. The successful VM was
destroyed; raw source/results/events have verified SHA256SUMS. An earlier attempt
failed before VM creation because the Multipass release catalog was briefly
unreachable; its launch-only evidence is preserved separately. No registry,
workloads or observer started in that attempt. The successful retry used the
same source and `--volume-state --managed-group --egress-mtu 1280`.

`--platform-inputs` also runs the platform permission provider as UID 1000.
Synthetic root-owned publications grant one valid plan, then reject stale current
pointers, changed ownership/host data, unreadable files and missing namespace
permission. Owned cleanup remains separately authorized without startup grants;
a deployment stop does not. Synthetic image/overlay/host references in this probe
are metadata only: no native workload, admission or deployment journal is used.

Runtime-factory source `20edf77` passed in fresh VM
`kayra-volume-lab-20261118155452575780` on 2026-11-18. The observer rebuilt its
runtime 26 times from accepted context, recorded one volume Create and 684
singleton effects across A/B/A and cancellation; the group recorded 21,209
observations. The successful VM was destroyed and raw source/results/events have
verified SHA256SUMS. Its grants and build inputs still used fixture callbacks;
the filesystem permission provider is the subsequent revision above.

The maintenance compatibility check additionally changes the old commit's artifact
identity and worker inputs before attempting an ordinary deployment. It must
still refuse across the data epoch, preserve the completed root and retain zero
old-version effects after migration. Metadata alone cannot grant forward schema
compatibility for a historical commit.

Platform-policy source `bd88079` passed in fresh VM
`kayra-volume-lab-20261118195448905520` on 2026-11-18 with
`--platform-inputs --volume-state --managed-group --egress-mtu 1280`.
The UID-1000 metadata probe accepted the valid grant and refused all six invalid
publication/namespace cases, preserving cleanup while refusing deployment stops
without current startup grants. The group recorded 19,097 observations and the
singleton recorded 607 effects with one Create. The successful VM was destroyed;
raw source/results/events have verified SHA256SUMS. The metadata-only scope of
that permission probe remains separate from workload admission evidence.

Maintenance and initial-cleanup reactivation can now obtain their next proposal
from the deployment owner. The probes compare its automatically selected verified
previous release, retained witnesses and inactive barriers with the expected
fixture evidence before acceptance. Proposal construction itself has no runtime,
writer or admission effects. These private version-1 maintenance fixtures keep
their existing accounting/allocation scope; ordinary version-2 indexed proposal
and public compiler/control integration remain separate acceptance work.

The indexed singleton also obtains A, B and cancellation proposals through the
app index after preparing the exact build receipts. It asserts the selected
previous release and action sequence before acceptance, while retaining its
catalog, observer reconstruction and A/B/A checks. This connects internal build
receipts to proposal ownership; public builder/CLI dispatch is still pending.

Epoch-guard source `98642aa` passed in fresh VM
`kayra-volume-lab-20261118202434154916` on 2026-11-18. Both unsafe-maintenance
and audited-resolution variants refused the metadata-rewritten historical commit,
retained schema 2 and recorded zero schema violations. The group recorded 18,619
observations; the singleton recorded 717 effects. Successful cleanup destroyed
the VM and archived raw source/results/events with verified SHA256SUMS. The prior
`95c681b` attempt hit a fixture ReferenceError before that check could run; its VM
is stopped and preserved after raw results and registry RAM were archived and
verified. The retry used a fresh VM with the assertion in the completed branch.

The indexed singleton fixture uses `managedPreparation` for build-to-acceptance
sequencing. It checks the owner-published execution context and compiled build
identity before acceptance, then reconstructs the same accepted operation after
observer recreation. Its compiler callback and grants remain synthetic; this is
not evidence for normal public deployment dispatch.

Proposal snapshot `cf7aaa3` passed in VM
`kayra-volume-lab-20261118204233154186` (destroyed): 18,083 group observations,
735 singleton effects and one volume Create across lost acknowledgement and
reopening; maintenance schema 2 with zero application fixture violations. Private
raw evidence and source snapshots have verified SHA-256 manifests.

The unprivileged platform-input probe also exercises the filesystem-backed
managed compiler with a synthetic registry resolver. It requires exact bundle
hash/commit/registration and rejects stale publications and corrupt bytes. This
establishes publication-reader behavior, not native image or overlay existence.

The UID-1000 platform probe constructs the same `managedPlatform` factory used
by the deployer process. A synthetic API accepts read requests only and checks
that construction and health-reader assembly perform no native access. This is
composition evidence with synthetic metadata, not a workload rollout claim.

Snapshot `afbf97b` reached safe migration holding when a ten-second maintenance
fixture step exhausted its window: the retained DB recorded schema 2 and the
stable operation identity after the retry deadline, with zero worker violations.
This failed run is preserved as negative recovery evidence. Nominal maintenance
fixtures now declare a 30-second migration step and a 10-second HTTP timeout;
job logs are retained before cleanup. Production deadlines and HTTP continuity
load-generator timeouts are unchanged.

Platform-composition snapshot `03df8a4` passed in VM
`kayra-volume-lab-20261118213900711931` (destroyed): 19,847 group observations,
649 singleton effects, four prepared requests and one volume Create. Its
UID-1000 composition probe issued only synthetic native reads; raw evidence and
source snapshots have verified checksum manifests.

The singleton fixture now routes prepare/cancel through `deploymentControl` and
`managedOperationControl`, validates public version-3 receipts, and reconstructs
accepted sources from the owner. Compiler and grant callbacks remain fixtures;
this does not enable mutations in the normal listener or establish CLI/network
integration.

Command-handler snapshot `acf6a53` passed in VM
`kayra-volume-lab-20261119014403301113` (destroyed): 20,755 group observations,
702 singleton effects and all four public prepare/cancel receipt paths. All
maintenance variants passed; main maintenance schema 2 with zero violations.
Private source, raw results, Docker events and diagnostics have verified SHA-256
manifests.

The singleton fixture additionally queries migration audit for both an original
completed run and its current run (neither declares a migration). This verifies
the native command/read path does not alter lifecycle state. Actual operator
resolution remains covered by the application-ledger maintenance fixture and
indexed command tests; this is not a normal listener or full-platform acceptance
claim.


The indexed singleton candidate now starts a long-running in-container check with
a two-second declared timeout. Recovery must stop and scrub B, prove the exact
check container has stopped, and reopen its journal before restoring A. Both
cessation and restoration share the original recovery deadline. The app-owned
lock history still verifies A/B/A coordination and graceful exit ordering.
Known-failed check recovery remains covered by the maintenance recovery fixture.
This remains an internal indexed command-path probe, not normal listener enablement
or a guarantee about remote effects initiated by application checks.


Unknown-check cessation snapshot `7bd3e1c` passed in VM
`kayra-volume-lab-20261125123320058813` on 2026-11-25 (destroyed).
The group captured 17,057 native observations; the singleton recorded 501
application-owned A/B/A effects and proved its timed-out check container ceased
before restoration, including a journal reopen. Maintenance, audited resolution,
cancellation, compatible recovery and initial cleanup passed; main maintenance
reached schema 2 with zero worker violations. The 360-entry raw archive, exact
source and 13 private evidence files have a verified SHA-256 manifest.

This run used Engine/CLI 29.10.1, API 1.57, Compose 5.8.0, Node 24.22.1,
Ubuntu 24.04.5 ARM64 and kernel 6.8.0-147-generic. Its image digests are recorded
in the evidence. These internal fixtures do not establish HTTP continuity,
normal mutation dispatch, full TLS/Authelia integration or remove/purge acceptance.

Run the managed-v3 path through the same upgraded platform with
`test/lab/upgrade.sh --from 0.23.0 --managed-rollouts --vm-name <unique-lab-name>`.
The opt-in adds a new app after the existing Compose and indexed Swarm checks.
It submits exact commits through the real builder and loopback deployment
control, kills and restarts the deployer during the app-owned migration, and
compares routed HTTPS traffic before and after release promotion. The observer
keeps the same fresh and persistent connection measurement and checks the
original admission and operation deadlines. It retains the per-request data,
Docker events, state trace, resource samples and exact versions.

The managed stage also retains four replacement builds before starting traffic.
It verifies a 15-second readiness delay, a candidate that never becomes
healthy, an automatic recovery after a candidate becomes healthy and exits, and
a 20-second request accepted by the previous release. Each case records at
least 30 seconds of traffic after convergence. The post-readiness failure
records failed requests, sampled disruption intervals, and elapsed time from
the native crash to verified recovery separately from the continuity cases.

Use `test/lab/upgrade.sh --from 0.23.0 --managed-fleet --vm-name <unique-lab-name>`
to exercise the regular fleet configuration and Ansible app role in a fresh
upgrade VM. This mode registers a Compose app and an opted-in Swarm app using
their own configuration files. It verifies HTTPS release and restore, writes a
marker to a named volume, and checks that its allocation, creation timestamp
and contents survive removal and explicit recreation. It then retires and
purges the fixture. It takes the ordinary platform setup path with no
registration lab Compose override.

Run `test/lab/upgrade.sh --from 0.26.1 --managed-forward --vm-name <unique-lab-name>`
to exercise audited forward recovery through the ordinary fleet path. The app
advances its retained ledger schema in a maintenance deployment, then fails
its completion check. Kayra should hold the data epoch and withdraw the active
release. The fixture requests an exact fix through `kayra app deployment forward`,
kills and restarts the deployer, and verifies the repaired release through HTTPS
with the original database task and one recorded migration attempt. It also
replays the same request. The successful VM is cleaned up and the reports for
the baseline, held and recovered releases and ledger are retained.
