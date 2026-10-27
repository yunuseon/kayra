# Admission and persistent-data lifecycle results

**All 18 cases met their declared expectations**, with zero failed requests and
zero premature candidate exposure. The experiment supports further Swarm
integration with explicit admission deadlines and volume ownership. It does not
supply a production admission controller or validate Kayra's current deployer
against Swarm.

## Run and environment

Run `20261027t190500419`, measured from clean source
`597f64ddddd7fd7b00bb64d7b9a12130a0932e87`,
2026-10-27T19:05:00.421Z–2026-10-27T19:30:34.615Z.
Fresh Ubuntu 24.04.5 LTS ARM64 Multipass VM: 2 CPUs, 4 GB RAM, 20 GB disk.
Docker Engine/CLI 29.9.2, API 1.56; Compose 5.6.1; PostgreSQL 18.6;
container Node 24.22.1 and locked `pg` 8.23.1. Host Node 24.21.0;
Multipass 1.16.1+mac. Guest kernel 6.8.0-147-generic.

The shared bootstrap uses Kayra's Docker role and these exact image pins:

```text
traefik:v3.7.16@sha256:c8a121e4bb1347e8fd52657fab12f2cb70b68f8a018895e2068f92c9e519b9c2
tecnativa/docker-socket-proxy:v0.5.0@sha256:1f5038b54f06c3e18422902cf00ba21803d1c97805aae032e5e6673d532d3459
node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
postgres:18.6-alpine3.24@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5
```

Socket-proxy API reads succeeded and writes were refused (403). Traefik used
service-VIP discovery, its normal refresh interval and no request retries.
The application had one replica, start-first updates, declared health checks,
a 30-second failure monitor, automatic failure rollback and 30-second shutdown
grace. Each request verifies database/file canaries and acknowledges a committed
UUID/value database write. A separate random 1 MiB file is checked by SHA-256.

## Measurements

| Case | Expectations met | Short requests / acknowledged writes verified | Failed requests | Required outcome |
|---|---:|---:|---:|---|
| memory-reservation | 3/3 | 4,621 | 0 | B pending; A serves; bounded cancellation restores A |
| candidate-oom | 3/3 | 2,438 | 0 | Candidate OOM before readiness; native automatic rollback |
| disk-admission | 3/3 | 3,147 | 0 | Lab headroom policy refuses without service mutation |
| candidate-enospc | 3/3 | 3,356 | 0 | Candidate startup write fails; native automatic rollback |
| retention-lifecycle | 3/3 | 5,709 | 0 | Replacement, rollback, removal and recreation retain data |
| purge-guard | 3/3 | 2,065, before intentional purge | 0 | Registered purge refused; explicit purge removes only owned data |

All **21,336 scenario requests** succeeded and their acknowledged values were
verified against PostgreSQL at the expected retention point. The lifecycle
cases retained all 5,709 writes, including 2,024 acknowledged by B, across
application removal and PostgreSQL/application container recreation. File
canaries and random payload hashes matched in every case. Purge cases
intentionally destroy the owned data after its pre-purge verification; they are
not a claim that those writes survive an explicit purge.

Traffic ran at 20 requests/s, split fresh/persistent connections, with two-second
deadlines and no retries. The lowest measured case rate was 19.36/s and largest
request-start gap 98 ms. Every case had a 30-second stable A tail after its
outcome. Raw access logs verified actual VIP routing without retries in all
18 continuity windows, and independently verified each recreated service's new
VIP. All three OOMs had native Docker OOM events, OOMKilled and exit-137 evidence;
all three ENOSPC candidates had logged ENOSPC and exit 42. Never-ready candidates
in the lifecycle cases had failed-health evidence and no premature exposure.

## Admission boundaries

The filler reserved enough scheduler memory to prevent overlap of A and B,
while touching 2,734,686,208 bytes. Docker measured **2.562 GiB** used by the
filler in each repetition. B remained pending with
`no suitable node (insufficient resources on 1 node)` and the service stayed
`updating` for 35.077 / 35.090 / 35.082 seconds after update acknowledgement,
beyond the configured 30-second failure monitor. A kept serving.

The lab then explicitly cancelled the attempt via native rollback and removed
the filler. Update submission through restored native state took
40.575 / 40.678 / 40.604 seconds. **The lab supplies that deadline. Swarm's failure
monitor did not terminate the unschedulable update.** A production coordinator
needs a bounded pending-update outcome and interruption-safe cancellation.
Reservations express declared budgets; the test does not predict an app's
actual peak usage. Standalone platform containers do not consume Swarm service
reservations, so their overhead must also be accounted for.

For candidate OOM, B exceeded its 128 MiB cgroup limit before becoming ready.
Automatic rollback settled in 6.567 / 6.663 / 6.511 seconds after submission,
without failed requests or B exposure. This tests a contained candidate failure;
it does not establish behavior under global kernel OOM or daemon failure.

Disk exhaustion used a **bounded 256 MiB ext4 filesystem** mounted inside the
VM. Its available bytes reached zero. A lab policy requiring 64 MiB free refused
before a service update, with an unchanged service version. Bypassing the check
made B's startup write fail with ENOSPC; automatic rollback settled in
6.483 / 6.533 / 7.069 seconds after update submission. A's database and persistent
files were on separate storage and stayed available. This does not establish
safety when Docker's root filesystem, the application's existing data filesystem
or its inode supply is exhausted.

## Removal, retention and purge

Each lifecycle sequence deployed B and observed acknowledged B writes, manually
rolled back to A, and attempted a never-ready update that automatically rolled
back. After the stable continuity window, traffic stopped before planned
maintenance. Native service removal retained both named volumes. Removing and
recreating the PostgreSQL container reused the same database volume; recreating
A reused the same file volume. Every earlier acknowledged value and file hash
was verified again. The deployment/rollback sequence took approximately
62.5–63.1 seconds; this was not an outage measurement.

The purge cases execute the **existing `scripts/server/app-purge`**, copied
unchanged into a lab-only platform directory. With the fixture registered,
all three calls refused with exit 1 and preserved data. After stopping/removing
application and PostgreSQL containers and unregistering the fixture, explicit
purge exited 0 and removed exactly the two owned named volumes. The unrelated
volume's canary survived. PostgreSQL recreated on a new volume had no `items`
table, proving the intended purge took effect.

The fixture explicitly labels owned volumes
`com.docker.compose.project=retention-lab`, matching the existing purge script's
selector. **Swarm must not be assumed to add Kayra's required ownership labels.**
A future adapter must create stable, explicitly owned volume identities and
preserve them across release changes. This lab uses native service removal;
it does not validate Kayra's Compose-based `app-remove` against Swarm.

## Resources and validity

All 354 VM telemetry samples were retained. The largest sample gap was 5.354
seconds, below the 15-second suspension guard. Peak sampled VM memory used was
3226.05 MiB; minimum available memory 675.42 MiB; peak sampled CPU busy fraction
27.13%. Resource samples grouped by case are in `audit.json`. Sampling can miss
short-lived allocation/CPU peaks. These observations do not size the full
platform or prove an admission budget.

The successful full-run VM was destroyed automatically. The six-case smoke
`20261027t182527919` also met its runtime expectations and passed raw replay
after correcting the analysis boundary between the old service VIP and the
recreated service VIP; that successful VM was then destroyed. The full run
captured and verified both VIP windows separately.

Two failed attempts completed no measured cases and remain stopped/preserved:
`kayra-swarm-lab-20261027t182352970` (lab directory permissions during setup) and
`kayra-swarm-lab-20261027t183714556` (VM launch timed out during host sleep).
They are excluded from feasibility results. The harness now holds an idle-sleep
assertion from launch onward and prints cleanup instructions even for partial
Multipass launches. Lid-close sleep can still interrupt measurements. The
existing `test` VM and host OrbStack Docker context were untouched.

## Decision and next integration requirements

Together with the [HTTP](../RESULTS.md), [migration](../migrations/RESULTS.md) and
[worker](../workers/RESULTS.md) experiments, these results keep Swarm viable for
a minimal experimental integration. The next design should specify:

- App-declared resource limits/reservations and overlap compatibility, with
  platform-overhead accounting and serialized/bounded admission.
- Durable deployment state and deadlines for pending, updating, cancelling and
  rolling back, recoverable after coordinator interruption.
- Stable application-owned volume identities, retention on removal, and an
  explicit guarded purge operation.
- App-owned readiness, migration compatibility, job delivery/idempotency and
  singleton ownership; Kayra sequences and observes those declared behaviors.

These are requirements supported by the experiments, not a new app contract or
implemented production coordinator. No production deployer/script was changed.
Global OOM, daemon/root-filesystem failure, inode exhaustion, concurrent admission
races, backups/restore, host loss, multi-node placement, TLS/Authelia, full-platform
load and Kayra's existing release-record recovery remain integration checks.
Retention through lifecycle operations does not constitute disaster recovery.

## Reproduction and raw evidence

```bash
# From the measured source, with Node 24, Multipass, Ansible and SSH:
bash test/lab/swarm/run.sh --suite admission --repeats 1
bash test/lab/swarm/run.sh --suite admission
node test/lab/swarm/admission/results.mjs .cache/swarm-admission-lab/RUN
node --test test/lab/swarm/lab.test.mjs test/lab/swarm/migrations/migrations.test.mjs test/lab/swarm/workers/workers.test.mjs test/lab/swarm/admission/admission.test.mjs
```

Keep the Mac awake with its lid open, preferably on power. Successful VMs are
destroyed unless `--keep`; failed labs preserve their VM and print cleanup
instructions. All 37 focused tests pass; measured-source CI passed. Independent
raw replay confirmed the complete 18-case result.

Raw directory: `.cache/swarm-admission-lab/20261027t190500419/`.
Archive: `.cache/swarm-admission-evidence-20261027t190500419.tar.gz`
(224 files, 4,680,654 bytes), SHA-256:
`60ef386f182fb33f6dac07284749292232bb900e73e9e6628a625d4a92552cd0`.
Every manifest entry was checked against the archive. These gitignored local
artifacts are not uploaded by the PR.

`summary.json` contains machine-readable results, versions and source hashes.
`commands.ndjson` records exact commands. Each case retains per-request results,
database rows, file hashes, admission/purge decisions, timelines, service/task/
container snapshots and logs. Global Docker events, full proxy logs and
VM/container telemetry provide independent runtime evidence.

Sources: [Swarm reservations and pending updates](https://docs.docker.com/engine/swarm/services/),
[volume lifecycle](https://docs.docker.com/engine/storage/volumes/),
[pruning semantics](https://docs.docker.com/engine/manage-resources/pruning/).
