# Swarm rollout feasibility lab

This standalone experiment compares Traefik's Swarm task-address discovery
with its service-VIP mode. It does not change Kayra's deployer or app contract.

Requirements: Multipass, Ansible, Node 24, SSH, and Docker CLI on the Mac.
The Docker CLI is used locally only to record the selected context. All
runtime changes happen over SSH in a fresh Ubuntu 24.04 VM (2 CPUs, 4 GB RAM,
20 GB disk), provisioned with Kayra's existing Docker role.

```bash
node --test test/lab/swarm/lab.test.mjs
bash test/lab/swarm/run.sh
```

Allow about an hour for provisioning and the full matrix. Progress is
printed after each phase and scenario. Results remain under
`.cache/swarm-lab/<timestamp>/` even when a successful VM is deleted.
Use `--output /absolute/new/directory` to choose another artifact directory.
The directory must not exist, so a new run cannot overwrite old evidence.

For a shorter harness diagnostic:

```bash
bash test/lab/swarm/run.sh --mode vip --scenario healthy --repeats 1 --keep
```

Partial runs are marked incomplete and cannot establish feasibility.
`--keep` retains successful VMs; failures always retain the VM and print its
name, cleanup command, and lab-only SSH key location. Cleanup targets only
the VM created by that run. The existing `test` VM and host Docker context
are not changed.

## Measurement

The full matrix runs six scenarios three times in each discovery mode:
healthy replacement, 15-second readiness delay, permanent readiness failure,
crash five seconds after the first successful health response, a 20-second request during replacement,
and actual termination/restart of the lab update observer.

Each mode starts with a 30-second healthy baseline. Cases start traffic five
seconds before the update and continue for at least 30 seconds after its
HTTP convergence (a stable expected release), recording native runtime
completion separately. Short requests run at 20/s, alternating fresh and persistent
connections. They have two-second deadlines and no retries. A sampling gap
over one second or an average below 18 requests/s invalidates the measurement
and stops the run as an infrastructure failure. Keep the host awake: suspending
Multipass also suspends the VM and invalidates deadline measurements. The same image
and runtime/provider settings are used in both modes, except for
`traefik.swarm.lbswarm`. Image pins are read from this checkout rather than
copied into another version list. Update monitoring is 30 seconds; rollback
monitoring is five seconds. The declared container health check has a
20-second startup period, one-second interval/timeout, and two retries.

Continuity cases require no failed requests or premature candidate exposure.
The post-readiness crash permits disruption but requires native rollback
within 90 seconds and a stable old release afterward. Docker events must prove
the candidate became healthy before its injected exit (code 42). Every case requires
30 seconds of the expected release after the last failed or wrong-release
response. Both runtime completion and HTTP recovery must occur within 90 seconds. A mode
is viable only if all 18 of its cases pass. Failure in the other mode does
not invalidate it. The command still exits nonzero if any case fails,
preserving the VM and all diagnostic evidence.

## Artifacts and interpretation

- `report.md`: exact versions, results, resource samples, and recommendation.
- `summary.json`: machine-readable results and full-matrix verdict.
- `commands.ndjson`, `lab.log`: reproduction and setup/control output.
- `docker-events.ndjson`, `metrics.ndjson`: daemon/health events, VM CPU/memory,
  and raw container resource samples.
- `traefik.log`, `socket-proxy.log`: proxy and API-access evidence.
- Per-case directories: every request, observer/timeline logs, service/task
  snapshots, and fixture container inspections/logs.

Assessment checks the actual backend addresses in Traefik access logs against
the service VIPs, so ignored/misapplied discovery labels cannot silently make
both modes test the same routing behavior. Reassess preserved raw evidence
with `node test/lab/swarm/analyze.mjs /absolute/output/directory`.
Proxy logs are streamed for the entire experiment, so Docker's log rotation
cannot discard early routing evidence. Missing routing evidence marks the
measurement incomplete.
Image downloads may retry up to three times during provisioning, before any
measurement. Application requests and proxy routing have no added retries.

Failed requests remain failures even when a later request succeeds. The
longest failure interval is sampled at the request rate; it is not an exact
outage duration. The observer test demonstrates Swarm's independence from
the submitting process, not recovery of Kayra's current release records.

HTTP routing is the scope. Passing does not establish TLS/auth integration,
migration safety, worker or singleton behavior, full-platform capacity,
multi-node availability, or production readiness. If neither mode passes,
compare the equivalent K3s experiment before adding custom traffic control.

The [shared-database migration suite](migrations/README.md) builds on the VIP
result: `bash test/lab/swarm/run.sh --suite migrations`.

The follow-up [worker and singleton lab](workers/README.md) runs with
`bash test/lab/swarm/run.sh --suite workers`. Its queue/locking protocols belong
to the fixture app and do not change Kayra's production deployment contract.
