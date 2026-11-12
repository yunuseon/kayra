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
