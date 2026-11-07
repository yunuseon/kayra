# Swarm rollout experiment — 2026-10-26

**Service-VIP discovery met the agreed HTTP criteria: 18/18 cases passed.**
Task-address discovery passed 9/18. Advance Swarm with VIP routing to the
migration/worker/singleton/admission/retention experiment; this does not select
Swarm for production. A K3s fallback experiment is not triggered by this result.

## Protocol and environment

The complete 36-case run was measured from clean commit
`ca1e4102a4d7a3ae723c2712e22a8292eecc412a` between 2026-10-26T20:04:05.434Z and 2026-10-26T20:59:19.771Z.
Run ID: `20261026t200405428`. Exact source hashes, commands, image IDs and
versions are in its machine-readable summary.

Ubuntu 24.04.5 LTS, ARM64, kernel 6.8.0-147-generic; 2 CPUs, 4 GB RAM,
20 GB disk. Docker Engine and CLI 29.9.2 (API 1.56), Compose 5.6.1.
Image pins:

- `traefik:v3.7.16@sha256:c8a121e4bb1347e8fd52657fab12f2cb70b68f8a018895e2068f92c9e519b9c2`
- `tecnativa/docker-socket-proxy:v0.5.0@sha256:1f5038b54f06c3e18422902cf00ba21803d1c97805aae032e5e6673d532d3459`
- `node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea`

The same fixture and settings were used in both modes. One replica,
start-first update/rollback, 30-second update monitor, automatic rollback,
30-second shutdown grace. Only `traefik.swarm.lbswarm` changed between modes.
The normal provider refresh interval was retained; no request retries or
additional proxy health checks were added. Docker API writes through the
socket proxy were rejected with 403; its discovery read returned 200.

Each mode had a 30-second healthy baseline. Cases sent 20 short requests/s
split between fresh and persistent connections, with two-second deadlines,
starting before the update and continuing for at least 30 seconds of stable
HTTP after convergence. Actual per-case rates were at least 19.35 requests/s;
the largest request-start gap was 163 ms. Runtime completion and HTTP
settlement are recorded separately.

## Comparison

| Scenario | Task passes | Task failed requests | VIP passes | VIP failed requests |
|---|---:|---:|---:|---:|
| healthy | 3/3 | 0 | 3/3 | 0 |
| slow-ready | 0/3 | 310 | 3/3 | 0 |
| never-ready | 3/3 | 0 | 3/3 | 0 |
| crash-after-ready | 3/3 | 746 | 3/3 | 249 |
| long-request | 0/3 | 14 | 3/3 | 0 |
| observer-interruption | 0/3 | 272 | 3/3 | 0 |

Across 50,793 scenario short requests, task discovery had 1,342 failures
(596 in continuity cases); VIP had 249, all in deliberate post-health crashes.
There were **zero premature candidate exposures** in either mode. All six
original 20-second requests completed on A. All six restarted observers
reconstructed service state, and Swarm continued independently.

All 36 cases had backend-address evidence confirming the intended task or VIP
routing and zero proxy retries. All six injected crashes had a Docker healthy
event before exit 42. The mode verdicts include those evidence checks, not
just the service's terminal status. No infrastructure or collection failure
was recorded in this run.

## Post-health crash disruption

| Discovery | Repeat | Failed requests | Runtime completion s | HTTP settlement s | Longest sampled failure interval s | First failed start to last failed completion s |
|---|---:|---:|---:|---:|---:|---:|
| tasks | 1 | 229 | 23.420 | 25.238 | 11.459 | 13.818 |
| tasks | 2 | 266 | 11.511 | 26.625 | 13.258 | 17.277 |
| tasks | 3 | 251 | 11.622 | 26.134 | 12.649 | 14.907 |
| vip | 1 | 82 | 23.211 | 23.261 | 4.179 | 6.131 |
| vip | 2 | 84 | 23.078 | 23.125 | 4.280 | 6.231 |
| vip | 3 | 83 | 23.128 | 23.135 | 4.218 | 6.169 |

Recovery times are measured from update submission. HTTP settlement is the
start of a stable expected-release window after native completion and the
last failed/wrong-release response. It is deliberately stricter than the first
successful recovery request. Failure intervals are sampled from requests;
they are not exact continuous outage measurements. The final column includes
in-flight request deadlines. **This is disruptive automatic recovery, not
uninterrupted rollback.** Fresh and persistent connections both experienced
failures; per-cause counts remain in `failure-details.json`.

## VM resources

Peaks per phase (used MiB / CPU busy percentage across the VM):

| Phase | Task discovery | VIP discovery |
|---|---:|---:|
| baseline | 562.70 / 11.67% | 577.50 / 11.73% |
| overlap | 619.14 / 22.13% | 618.33 / 18.65% |
| failure | 575.81 / 15.50% | 585.84 / 18.65% |
| recovery | 589.86 / 20.27% | 594.62 / 14.98% |

Overall peak used memory was 619.14 MiB, minimum available memory 3,282.34 MiB,
and peak CPU busy fraction 23.58%, across 786 VM samples. Overlap means at least
two live containers in the current service, derived from Docker start/die
events. Per-case phases, intervals and a reproducible extraction script are
included in `resource-phases.json` and `resource-phases.py`. These minimal-lab
measurements do not establish full-platform sizing.

## Reproduction and evidence

From this checkout with Multipass, Ansible, Python and Node 24 available,
keep the host awake for about an hour:

```bash
node --test test/lab/swarm/lab.test.mjs
bash test/lab/swarm/run.sh --output /tmp/kayra-swarm-comparison
node test/lab/swarm/analyze.mjs /tmp/kayra-swarm-comparison
```

Local raw artifacts are under `.cache/swarm-lab/20261026t200405428/`:
`summary.json`, `report.md`, per-request NDJSON and snapshots, Docker events,
full Traefik/socket-proxy logs, resource samples, and setup/control commands.
The local evidence archive has a SHA-256 manifest. Earlier diagnostic attempts
are explicitly excluded from this verdict; their index records harness issues
and host-suspension failures.

The overall command exits nonzero when either mode fails, so the VM was
preserved even though VIP passed. It has been stopped, retaining its disk.
Successful focused lab VMs were destroyed automatically. Cleanup for this run:

```bash
multipass delete --purge kayra-swarm-lab-20261026t200405428
```

The existing `test` VM and host OrbStack Docker context were unchanged.

## Limits and next experiment

Single-node ARM64 HTTP only. This establishes no guarantees about migrations,
workers, singleton exclusion, app-specific admission, data retention, TLS,
Authelia, full-platform overhead, x86 hosts or multi-node availability.
Observer interruption proves native runtime durability; it does not prove
recovery of Kayra's existing release records. Applications still own their
readiness and compatibility behavior through a future platform contract.
The next experiment must test those application and data constraints before
any production rollout integration.
