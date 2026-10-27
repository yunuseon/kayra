# Worker and singleton feasibility results

**All 18 cases met their declared expectations**, including two unsafe negative
controls repeated three times. Swarm replaced worker processes while an
application-owned queue/locking protocol supplied job recovery, idempotency and
singleton ownership. The experiment does not select Swarm for production or
make arbitrary workers safe to overlap.

## Run and environment

Run `20261027t180020784`, from clean commit
`8ef68246d75c71e2f6dcb68de90b0fd94693a3b1`,
2026-10-27T18:00:20.788Z–2026-10-27T18:11:24.368Z. A separate six-case smoke
(`20261027t175437868`, same source) passed before the full matrix.

Fresh Ubuntu 24.04.5 LTS ARM64 Multipass VM, 2 CPUs, 4 GB RAM, 20 GB disk;
Docker Engine/CLI 29.9.2, Compose 5.6.1; PostgreSQL 18.6; container Node 24.22.1;
node-postgres (`pg`) 8.23.1 with the migration fixture's committed lockfile.
Host Node 24.21.0. The shared bootstrap used Kayra's Docker role, pinned
Traefik v3.7.16 and socket proxy v0.5.0, with API writes through the proxy
refused (403). Workers used only the internal overlay and PostgreSQL; no HTTP
traffic or routing change was involved in these cases.

Exact image pins:

```text
traefik:v3.7.16@sha256:c8a121e4bb1347e8fd52657fab12f2cb70b68f8a018895e2068f92c9e519b9c2
tecnativa/docker-socket-proxy:v0.5.0@sha256:1f5038b54f06c3e18422902cf00ba21803d1c97805aae032e5e6673d532d3459
node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
postgres:18.6-alpine3.24@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5
```

## Measurements

Each queue case had 20 jobs. Each worker service declared one replica,
start-first updates and 30-second shutdown grace. A four-second renewable
lease and attempt token guarded each claim; the effect and acknowledgement
committed separately. Singleton cases retained ownership through a deliberate
five-second in-flight operation after SIGTERM.

| Case | Expectations met | Jobs / attempts / durable effects, across 3 repeats | Work completion or handoff, seconds per repeat |
|---|---:|---|---|
| graceful-drain | 3/3 | 60 / 60 / 60 | 19.841 / 19.671 / 20.168 |
| killed-worker | 3/3 | 60 / 63 / 60 | 9.801 / 9.764 / 10.030 |
| effect-idempotent | 3/3 | 60 / 63 / 60 | 4.244 / 4.905 / 4.117 |
| effect-without-idempotency | 3/3, unsafe control | 60 / 63 / 63 | 3.837 / 4.916 / 3.896 |
| singleton-locked | 3/3 | Zero ownership overlap | 10.674 / 10.842 / 11.204 |
| singleton-unlocked | 3/3, unsafe control | Ownership overlap 9.335 / 9.409 / 9.230 seconds | 1.290 / 1.293 / 1.293 |

Timings run from acknowledged update/kill to all jobs acknowledged, or B
acquiring singleton ownership. They include the configured job/drain time and
process startup; they are not HTTP outages or exact worker restart times.

Across the matrix, **240 jobs completed in 249 attempts**. All 240 had durable
effects. The only extra effects were the three expected duplicates in the
control without idempotency. Each job had one final acknowledgement. All nine
SIGKILL injections had Docker exit-137 evidence and redelivery to a different
task. The other 28 worker exits, including baseline and teardown, were clean
exit 0; no unexpected application exit was observed.

All three 20-second A jobs completed after B had started, and A exited cleanly.
Lease renewal kept those jobs from being reclaimed during overlap. In each
idempotent crash case, the target had two attempts but one durable database
effect. Without the unique effect key, that same commit-before-ack crash window
produced two effects. This demonstrates redelivery, not exactly-once execution.

With the singleton advisory lock, B started 9.278 / 9.338 / 9.912 seconds before
A released ownership, but stayed on standby. Ownership intervals never
overlapped; the measured gaps between A's release and B's acquisition were
100.802 / 23.888 / 115.268 ms. These sampled database intervals do not establish
continuous work throughput. Without the lock, both tasks performed exclusive
work during each roughly nine-second ownership overlap. **One configured
replica is not an exclusion mechanism during start-first updates.**

## Resources and measurement validity

The baseline produced 334 work ticks spanning 39.277 seconds including drain;
its largest tick gap was 230 ms. No infrastructure failure was recorded.
All 138 VM telemetry samples were retained; the largest sampling gap was
6.075 seconds, below the 15-second suspension guard. Peak VM memory used was
669.09 MiB, minimum available memory 3232.39 MiB, and peak sampled CPU busy
fraction 26.54%. These are small-fixture observations, not capacity/admission
limits or full-platform overhead measurements.

Both the smoke and full successful VMs were destroyed automatically. The
existing `test` VM stayed running and the host Docker context stayed `orbstack`.
Two earlier suspended attempts completed no worker cases; their stopped VMs
and logs remain diagnostic evidence, not Swarm failures:
`kayra-swarm-lab-20261027t000541010` and
`kayra-swarm-lab-20261027t064306748`.

## What this supports

- Overlap-safe workers can drain on SIGTERM within the declared grace period.
  A killed process still needs the queue's redelivery/reclaim mechanism.
- Committing an effect before acknowledging a job leaves a duplicate-delivery
  window. Applications need effect idempotency or another explicit protocol.
- A singleton can stay healthy while waiting for ownership, then acquire it
  after the old owner drains. Making ownership a prerequisite for candidate
  readiness could deadlock a start-first handoff.
- Kayra can expose runtime update order/grace and sequence app-owned commands;
  the application or its queue must define delivery, effect deduplication and
  exclusive ownership. Swarm does not infer these from a replica count.

Together with the HTTP and migration experiments, this keeps Swarm viable for
further integration testing. The next isolated checks should cover admission
under resource pressure and persistent-data retention/recovery, before defining
a production rollout contract. TLS/Authelia, full platform overhead, multi-node
behavior and Kayra's existing release-record recovery remain untested here.

This fixture's SQL is not a production queue implementation. Its effect key
protects only the database insert; it does not deduplicate arbitrary external
API calls. Advisory locking does not fence an external resource after database
session loss. Network partitions, stale owners after lease loss, database
failover, real queue compatibility and jobs exceeding shutdown grace were not
exercised. Production Kayra behavior and its app contract were not changed.

## Reproduction and evidence

```bash
# From the recorded source, with Node 24, Multipass, Ansible and SSH installed:
bash test/lab/swarm/run.sh --suite workers --repeats 1
bash test/lab/swarm/run.sh --suite workers
node test/lab/swarm/workers/results.mjs .cache/swarm-worker-lab/RUN
node --test test/lab/swarm/lab.test.mjs test/lab/swarm/migrations/migrations.test.mjs test/lab/swarm/workers/workers.test.mjs
```

Keep the Mac awake with its lid open, preferably on power. Successful labs are
destroyed unless `--keep`; failures preserve the VM and print cleanup commands.
All 31 focused tests passed. Raw replay independently rechecked the full matrix.

Raw run: `.cache/swarm-worker-lab/20261027t180020784/`.
Archive: `.cache/swarm-worker-evidence-20261027t180020784.tar.gz`
(165 files, 503,503 bytes), SHA-256:
`a5bba0a9e63a19829e23de8c3aad65c946bef3faa199abe56e5f0b14a945dc22`.
The archive manifest was checked against every recorded file. These local,
gitignored artifacts are not uploaded by the PR.

`summary.json` contains machine-readable results, versions and source hashes;
`commands.ndjson` records exact commands. Each case's `evidence.json` retains
jobs, effects, application history, ownership intervals, work ticks, injection
timestamps and service snapshots. Container/task logs and inspections, global
Docker events and VM/container metrics supply independent runtime evidence.

Sources for the tested mechanisms: [Docker update overlap](https://docs.docker.com/reference/compose-file/deploy/#update_config),
[PostgreSQL queue locking](https://www.postgresql.org/docs/18/sql-select.html),
and [application advisory locks](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS).
