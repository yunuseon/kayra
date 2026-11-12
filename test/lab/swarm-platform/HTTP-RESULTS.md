# Real-deployer HTTP continuity — 2026-11-12

**VIP routing passed 18/18 cases through the real indexed deployer.** This
advances the experimental integration; migrations, workers, singletons,
maintenance, removal/purge and remaining operator acceptance are not complete.

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
