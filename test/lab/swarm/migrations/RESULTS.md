# Shared-database migration results

**All 24 cases met their declared expectations.** The six continuity scenarios
had zero failed requests across three repetitions each. The other two scenarios
measured deliberate crash recovery and proved an unsafe schema rollback.
This establishes a workable fixture protocol; it does not make arbitrary
application migrations safe or select Swarm for production.

## Run and environment

Run `20261026t231940865`, measured from clean commit
`57e98b0b2ac241f073683112116fd360d5b967d1`, 2026-10-26T23:19:40.866Z–2026-10-26T23:50:07.986Z.
Fresh Ubuntu 24.04.5 LTS ARM64 VM, 2 CPUs, 4 GB RAM, 20 GB disk;
Docker Engine/CLI 29.9.2, Compose 5.6.1. PostgreSQL 18.6, Node 24.22.1,
node-postgres (`pg`) 8.23.1 with a committed dependency lockfile.

Service-VIP discovery used the same Traefik v3.7.16 and socket proxy v0.5.0
pins as the HTTP experiment. PostgreSQL pin:
`postgres:18.6-alpine3.24@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5`.
All other image digests/IDs, exact versions, measured source hashes and commands
are in the raw summary. No infrastructure failure was recorded.

## Measurements

| Scenario | Expectations met | Failed requests | Acknowledged writes retained |
|---|---:|---:|---:|
| expand-rollback | 3/3 | 0 | 4,960 |
| transaction-failure | 3/3 | 0 | 2,100 |
| concurrent-migrations | 3/3 | 0 | 2,400 |
| interrupted-before-commit | 3/3 | 0 | 2,173 |
| interrupted-after-commit | 3/3 | 0 | 2,173 |
| lock-contention | 3/3 | 0 | 2,573 |
| candidate-crash | 3/3 | 271 | 3,094 |
| destructive-rollback | 3/3 | 250 | 5,521 |

The run sent **25,515 scenario short requests**, of which 24,994 succeeded
and acknowledged committed writes. Every acknowledged ID/value and the seed
canary were checked against PostgreSQL after its scenario: **zero acknowledged
writes lost or corrupted**, including 7,580 writes acknowledged by B.
Readiness probes and requests without a successful response can leave extra
rows; these are reported separately, not claimed as exactly-once delivery.

Traffic targeted 20 requests/s, half fresh connections and half persistent,
with two-second deadlines and no retries. The lowest measured case rate was
19.58/s; the largest request-start gap was 85 ms. Every case included at least
30 seconds of stable expected-release HTTP after its outcome. All 24 had raw
proxy evidence of actual VIP routing without retries. All three candidate
crashes had native Docker healthy-before-exit-42 evidence.

## Deliberate disruption and unsafe rollback

| Scenario | Repeat | Failed requests | Failed-start span s | First failed start to last failed completion s | HTTP settlement s | Runtime outcome |
|---|---:|---:|---:|---:|---:|---|
| candidate-crash | 1 | 87 | 4.381 | 6.382 | 23.618 | rollback_completed |
| destructive-rollback | 1 | 83 | 4.187 | 6.188 | 62.247 | rollback_paused |
| candidate-crash | 2 | 91 | 4.579 | 6.582 | 23.820 | rollback_completed |
| destructive-rollback | 2 | 83 | 4.178 | 6.179 | 63.070 | rollback_paused |
| candidate-crash | 3 | 93 | 4.691 | 6.692 | 18.447 | rollback_completed |
| destructive-rollback | 3 | 84 | 4.228 | 6.229 | 63.324 | rollback_paused |

The candidate-crash cases automatically restored A while keeping the expanded
schema and all acknowledged writes, including B's. This is disruptive recovery,
not uninterrupted rollback. Fresh and persistent connections both failed.
Request spans are sampled disruption measurements, not exact continuous outage
lengths. HTTP settlement is the start of the stable window after native outcome
and the last failed/wrong-release response, timed from the scenario's migration/
deployment sequence start.

In each destructive control, contraction removed the column A needs. B then
served the new schema. The attempted image rollback targeted A but paused
because A could not become healthy; B continued serving. The legacy SQL probe
returned PostgreSQL `42703` (undefined column), and the schema stayed contracted.
A PASS here means **unsafe rollback was demonstrated**, not that it succeeded.
Its roughly 63-second settlement includes both B's deployment and the attempted
A rollback; it does not mean a 63-second HTTP outage.

## What this supports

- A backward-compatible expansion plus B's dual writes allowed A/B overlap and
  rollback without request failures or loss of acknowledged data.
- A failed transactional migration can leave schema and service unchanged.
  The lab withheld service updates on migration failure.
- Concurrent migration attempts need app-owned serialization and idempotence.
  Two overlapping attempts committed the schema change once; the other skipped.
- Killing a migrator after DDL/ledger insertion but before commit rolled both
  back. Retrying committed once. Killing it after commit preserved the change;
  retrying used the ledger and skipped. A failed process exit cannot establish
  that the database is unchanged.
- Even additive DDL can wait on application locks. The fixture's 500 ms DDL
  lock timeout rejected that attempt while A stayed available.
- Image rollback cannot repair incompatible schema changes. Destructive
  contraction needs a separate app-defined phase/maintenance strategy, after
  the required overlap and rollback compatibility window.

Kayra can sequence an app's opaque migration command and honor declared
compatibility. The application must own SQL, transaction boundaries, locking,
ledger/replay behavior, readiness and dual writes. The lab's migration-before-
update gate is a coordinator prototype; **Swarm does not supply that gate, and
Kayra's current production deployer was not changed**. This experiment does not
define a new app contract. Existing release-record recovery remains untested.

## Resources and reproduction

Across 421 VM samples, peak used memory was 685.54 MiB, minimum available
memory 3,215.93 MiB and peak CPU busy fraction 28.95%. These are a small fixture's
measurements, not full-platform sizing. Per-case migration/failure/recovery
samples and extraction code accompany the raw metrics.

```bash
node --test test/lab/swarm/lab.test.mjs test/lab/swarm/migrations/migrations.test.mjs
bash test/lab/swarm/run.sh --suite migrations
node test/lab/swarm/migrations/results.mjs /absolute/output/directory
```

Allow roughly 30 minutes for the full matrix and keep the host awake. Raw
artifacts are in `.cache/swarm-migration-lab/20261026t231940865/`: machine-readable
summary, every request, complete database/schema/ledger snapshots, migration
inspections/logs, service/task/container snapshots, native health events,
Traefik/socket-proxy/PostgreSQL logs and resource samples. The evidence archive
has a SHA-256 manifest. Earlier check runs are excluded from this verdict.

The successful full-run and successful one-run-check VMs were automatically
destroyed. The first failed harness VM is stopped and preserved; its cleanup
command is `multipass delete --purge kayra-swarm-lab-20261026t225925541`.
The existing `test` VM and host OrbStack context were unchanged.

## Limits and next step

Single-node PostgreSQL-specific fixture behavior under HTTP load. Large
backfills, nontransactional DDL, external side effects, database failover,
backup restore, TLS/auth integration, production workload sizes and multi-node
behavior were not established. The next isolated experiment should cover
workers, job delivery and singleton exclusion before production integration.
