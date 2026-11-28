# Real-deployer HTTP continuity

## Managed rollouts on the November 28 pins

The managed coordinator ran against the frozen product source
`f09c0c3792c23c4428e2b90d4278f9cd0c7a82d0` in a fresh upgrade from Kayra
0.26.1. The environment was Multipass 1.17.2, Ubuntu 24.04.5 ARM64,
kernel 6.8.0-147-generic, Docker Engine and CLI 29.10.1 (API 1.57),
Compose 5.8.1 and Traefik 3.7.16
(`sha256:1336e85aaed293bd63d005086e0dd013b04078b26aaeb1c18b26a2f928af7e65`).
The platform served Compose and Swarm together over HTTPS. The Swarm socket
proxy denied the attempted writes. Traefik selected service VIPs.

| Managed case | Short requests | Failed requests | Verified outcome |
|---|---:|---:|---|
| Healthy replacement with migration and deployer interruption | 3,232 | 0 | The migration continued and the restarted deployer verified the release |
| Readiness delayed 15 seconds | 1,885 | 0 | Replacement verified |
| Candidate never ready | 2,653 | 0 | Failure reported after 35.6 s, rollback settled after 99.6 s from submission |
| Exit after readiness | 2,473 | 93 | Previous release verified 66.0 s after exit |
| Original 20-second request | 1,729 | 0 | Original release returned HTTP 200 in 20.018 s |
| Candidate OOM after readiness | 2,231 | 88 | Previous release verified 49.0 s after OOM |

No candidate served before readiness. The maximum observed start gap was
194.6 ms across those cases at 20 requests/s with fresh and persistent HTTPS
connections. The post-readiness exit produced a 4.500 s longest sampled
failed-start interval and a 14.506 s span from first failed start to last
failed completion. The OOM produced 4.322 s and 6.323 s respectively.
These are sampled intervals. Recovery time includes native monitoring and
coordinator verification.

The fresh run passed its Compose upgrade, TLS, Authelia and managed HTTP
checks. It then stopped before the managed disk-full fault because the
earlier fault's ext4 mount still held the live journals. The fixed observer
verified and reused that mount. Managed ENOSPC passed with zero failures
across 2,430 requests, the same request and deadline, and one candidate start.
The resumed admission race passed with zero failures across 1,629 requests,
one winner start and no workload created for the other contender. Final
mixed-fleet verification passed on the same VM, which was stopped and kept
with the original failure evidence.

```bash
bash test/lab/upgrade.sh --from 0.26.1 --managed-rollouts \
  --egress-mtu 1280 --vm-name kayra-timed-matrix-unique
```

See [MANAGED-RESULTS.json](./MANAGED-RESULTS.json) for case identities,
availability measurements and raw evidence checksums. The managed matrix
uses VIP discovery. The [standalone comparison](https://github.com/yunuseon/kayra/blob/codex/swarm-rollout-lab/test/lab/swarm/RESULTS.md)
contains the task-address measurements.

## Indexed deployer rehearsal on November 12

**VIP routing passed 18/18 cases through the real indexed deployer.** This
rehearsal preceded the managed migration, worker, singleton, maintenance and
removal tests.

The runtime server used `a3b4c0ecbbe564187909e1f95bff133e071c18bd` (#243).
The observer ran from a frozen snapshot whose file hashes are retained beside
the raw evidence. All workload changes went through the existing deployer's
loopback lifecycle interface, retained builder artifacts, admission, private
materialization and native adapter. There was no custom traffic switch.

## Results

| Case | Passes | Failed short requests | Premature candidate exposure |
|---|---:|---:|---:|
| Healthy replacement | 3/3 | 0 | 0 |
| Readiness delayed 15 seconds | 3/3 | 0 | 0 |
| Candidate never ready | 3/3 | 0 | 0 |
| Failure after readiness | 3/3 | 248 | 0 |
| Original 20-second request | 3/3 | 0 | 0 |
| Coordinator killed after native acknowledgement | 3/3 | 0 | 0 |

There were 31,361 scenario short requests and 601 healthy-baseline requests.
Each case achieved at least 19.98 requests/s, split between fresh and persistent
TLS connections, without client retry and with two-second deadlines. Traffic
started before each update and continued at least 30 seconds after convergence.
All three long requests completed on their original A task in approximately
20 seconds. All three interrupted operations reconstructed their original UUID,
plan and update deadline after the existing deployer container was killed and
restarted. Every case had service-VIP backend-address evidence and zero recorded
Traefik retry attempts. Independent analysis verified health-before-crash on
the same candidate container for each crash case.

| Post-readiness crash | Failed requests | Verified recovery from submission s | Longest sampled failed-start interval s | First failed start to last failed completion s |
|---|---:|---:|---:|---:|
| 1 | 84 | 53.639 | 4.151 | 6.152 |
| 2 | 85 | 53.674 | 4.199 | 6.199 |
| 3 | 79 | 53.527 | 3.771 | 5.771 |

These are **disruptive automatic recoveries**, not uninterrupted rollback.
Sampled failure intervals are not exact continuous outage measurements. The
larger recovery time includes native monitoring and coordinator verification.

## Environment and resources

Ubuntu 24.04.5 LTS, ARM64, kernel 6.8.0-147-generic; VM: 2 CPUs, 4 GB RAM,
20 GB disk. Engine/CLI 29.9.3, API 1.56, Compose 5.7.0, Node 24.22.1.

Pinned routing images:

- `traefik:v3.7.16@sha256:c8a121e4bb1347e8fd52657fab12f2cb70b68f8a018895e2068f92c9e519b9c2`
- `tecnativa/docker-socket-proxy:v0.5.0@sha256:1f5038b54f06c3e18422902cf00ba21803d1c97805aae032e5e6673d532d3459`
- Fixture base: `node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea`
- Built fixture: `localhost:5000/rollout-http/web@sha256:aa0c3b8e864369b44b04c6e49a10272ab185fd84aff74e8b342f39eca403e828`

The fixture declares 128 MiB / 250 millicore limits, 64 MiB / 125 millicore
reservations, a 20-second health start period, 30-second shutdown grace and
30-second failure monitoring. The provider's normal refresh configuration was
preserved. Exact platform image IDs, host authority and source hashes are in
`prepared/environment.json`; pinned image references were also captured after
the run, before changing the server image.

VM peaks, including the full platform and temporary in-VM observer/CLI polling:

| Phase | Used MiB | Aggregate CPU busy % | Samples |
|---|---:|---:|---:|
| Baseline | 964.09 | 27.86 | 30 |
| Candidate overlap | 1156.17 | 92.47 | 287 |
| Sampled failure window | 1146.14 | 83.96 | 18 |
| Recovery | 1148.18 | 83.96 | 200 |
| Overall | 1186.82 | 98.26 | 2338 |

CPU values are one-second sample peaks across both VM CPUs, not steady-state
platform-only sizing. Minimum available memory was approximately 2.65 GiB.
A separate compensation probe observed three concurrent containers: draining A,
B and restored A. The subsequent cancellation/admission work reserves that
recovery overlap; this matrix alone does not validate worst-case admission.

## Evidence and reproduction

Raw evidence and the independent report are retained at:

- `/tmp/kayra-http-matrix-run2/results/` — request JSONL, runtime/health events,
  filtered access logs, application logs, VM samples, `analysis.json`, `REPORT.md`.
- `/tmp/kayra-http-matrix-run2/prepared/` — builds, exact versions and image pins.
- `/tmp/kayra-http-matrix-run2.tgz` — archived source provenance and raw evidence.
- `/tmp/kayra-http-matrix-run2-live.log` — progress and measured outcomes.
- `/tmp/kayra-http-load-run2-context.json` — retained VM paths.
- `/tmp/kayra-http-baseline-invalid/` — rejected relative-timer baseline:
  356 successful requests in 30 seconds; excluded for insufficient load.

Reproduce using the fixture preparation, staging and driver commands in the
README. Analyze exported evidence independently:

```bash
node test/lab/swarm-platform/analyze-http.mjs <export>/results
```

The source VM was already preserved from an earlier failure, so the managed
fixtures and data remain under coordinator ownership. Successful disposable
probe services were removed. A separate full upgrade from release 0.23.0
through #243 passed legacy deployment, routing/TLS/auth, indexed registration,
real HTTP promotion and final verification; its successful VM was destroyed.
Its logs are `/tmp/kayra-http-control-20261112100739.log` and its reports are
`/tmp/kayra-swarm-platform-kayra-http-control-20261112100739*.json`.

## Managed coordinator observations after the initial matrix

The managed coordinator was exercised through Kayra's real builder, deployer
and HTTPS routing on November 26. The observations below came from separate
sessions in the same lab VM. The initial replacement included a deployed
migration, a deployer process kill, and recovery using the original operation.
The test found one run of the app migration. Subsequent individual cases
measured routed readiness and automatic recovery.

| Case | Short requests | Failed requests | Premature candidate requests | Outcome |
|---|---:|---:|---:|---|
| Healthy replacement with migration and deployer restart | 3,245 | 0 | 0 | Verified B |
| 15-second readiness delay | 1,871 | 0 | 0 | Verified C |
| Candidate never becomes ready | 2,593 | 0 | 0 | Failure observed after 36.671 s, previous release verified again after 96.568 s |
| Failure after readiness | 2,448 | 92 | 0 | Automatic verified recovery 64.443 s after the native exit |
| 20-second request on the old release | 1,724 | 0 | 0 | The original request completed on C with HTTP 200 in 20.040 s |
| Candidate container OOM | 2,199 | 84 | 0 | Automatic verified recovery 48.867 s after the native OOM |
| Bounded lifecycle metadata ENOSPC | 2,611 | 0 | 0 | One candidate start after space returned |
| Competing admission across restart | 1,705 | 0 | — | One winner start, zero workload objects for the loser |

In the two disruptive cases, the first failed request start to last failed
completion spanned 14.502 s after an ordinary candidate exit and 6.147 s after a
candidate OOM. These intervals describe the observed requests. The never-ready
case met the failure-reporting deadline while final settlement took longer. Its
original observer asserted that settlement itself had to take at most 90 s and
retained the run as a failed observer result. The replacement retained C and
returned successful responses throughout the measured window.

The November 26 VM was Ubuntu 24.04.5 LTS ARM64, kernel 6.8.0-147-generic, with
2 CPUs, 4 GiB RAM and 20 GiB disk. Engine and CLI were 29.10.1, Compose was
5.8.0 and the observer used Node 24.22.1. Its Traefik and socket-proxy image
digests matched the earlier matrix. The upstream merge later changed the
pinned Traefik v3.7.16 digest to
`sha256:1336e85aaed293bd63d005086e0dd013b04078b26aaeb1c18b26a2f928af7e65`.
A subsequent run using the new pin verified native rollback after a candidate
OOM. One 261.809 ms request-start gap exceeded the 250 ms measurement limit,
so that run is excluded from timing acceptance.

`MANAGED-RESULTS.json` records the selected observations and raw archive
identities. The private archives contain individual requests, Docker events,
runtime observations and resource samples under
`.cache/lab-evidence/kayra-managed-upgrade-20261126102726/`. The rejected
measurement is kept under
`.cache/lab-evidence/kayra-managed-matrix-20261127000543/`.
Reproduce the integrated cases on a fresh upgrade VM with:

```bash
bash test/lab/upgrade.sh --from 0.26.1 --managed-rollouts \
  --vm-name "kayra-managed-matrix-$(date -u +%Y%m%d%H%M%S)"
```

These observations are evidence for keeping the experimental VIP adapter.
A complete fresh run using the current image pin is still required for the
integrated HTTP and resource matrix.
