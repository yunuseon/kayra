# Shared-database migration experiment

This follows the HTTP experiment's service-VIP result. It adds an app fixture
and a PostgreSQL database to the same fresh-VM lab. It does not change Kayra's
production deployer or define a new app contract.

```bash
node --test test/lab/swarm/lab.test.mjs test/lab/swarm/migrations/migrations.test.mjs
bash test/lab/swarm/run.sh --suite migrations
# First exercise all scenarios once (not a complete feasibility result):
bash test/lab/swarm/run.sh --suite migrations --repeats 1
# Reassess raw artifacts:
node test/lab/swarm/migrations/results.mjs /absolute/output/directory
```

Keep the host awake. The full matrix repeats eight scenarios three times,
with a read/write workload of 20 requests/s, no client retries, two-second
request deadlines and 30 seconds of stable HTTP after each outcome. The
existing lab's traffic-gap and telemetry checks apply. Logs default to
`.cache/swarm-migration-lab/<timestamp>/`. Partial runs remain incomplete.
Successful VMs are destroyed unless `--keep`; failed VMs are preserved.
Only fresh lab VMs are modified; the existing `test` VM and host Docker
context remain untouched.

| Scenario | Required evidence |
|---|---|
| expand-rollback | Expand schema, deploy dual-writing B, roll back to A; zero HTTP failures and all acknowledged values readable by A |
| transaction-failure | Intentional SQL failure rolls back DDL/ledger; service unchanged and zero HTTP failures |
| concurrent-migrations | Two overlapping attempts serialize through an app-owned advisory lock; exactly one application/ledger row and one idempotent skip |
| interrupted-before-commit | Kill after transaction lock acquisition; schema unchanged, retry applies once, A remains available |
| interrupted-after-commit | Kill after commit but before process success; schema/ledger persist, retry skips, A remains available |
| lock-contention | Hold an application read transaction; migration hits its 500 ms DDL lock timeout; schema/service unchanged and no failed HTTP requests |
| candidate-crash | B becomes Docker-healthy, writes data, then crashes; native rollback to A within 90 seconds, expanded schema and all acknowledged values retained |
| destructive-rollback | Commit incompatible DDL, deploy compatible B, attempt A rollback; prove legacy SQL fails and rollback cannot complete while B remains serving |

A PASS on the destructive negative control means unsafe rollback was
**demonstrated**, not that rollback succeeded. Its intentional HTTP disruption
is reported separately, as is candidate-crash disruption. Other scenarios
require zero failed requests. Successful HTTP replies identify their committed
write and value. The analyzer checks every acknowledged write and the seed
canary against the database, including B's writes after A is restored. Extra
rows from readiness probes or requests without a successful response are
reported; this is not an exactly-once request-delivery experiment.

The lab runner runs a one-shot migration before submitting an update and
keeps the service unchanged on migration failure. That sequencing is a lab
prototype, not a native Swarm feature or proof that Kayra currently does it.
The fixture owns SQL, transaction boundaries, advisory locking, checksums,
ledger and dual writes. Kayra should eventually consume an opaque app contract,
not infer safety by inspecting an application's schema.

Raw evidence includes every request, service/task/container snapshots,
migrator exit states and structured logs, before/after database rows and
schema/ledger, interruption snapshots, Docker health events, actual Traefik
backend addresses, PostgreSQL logs and VM/container resource samples. Image
pins, driver lockfile and exact measured source hashes are recorded.

PostgreSQL-specific behavior is deliberate. Not all DDL is transactional, and
an additive schema change can still block traffic while acquiring locks.
This fixture bounds DDL lock waits rather than claiming additive changes are
always safe. Real app backfills, nontransactional DDL, external side effects,
workers, singleton exclusion, database failover, backup restore and Kayra
release-record recovery remain outside this experiment.

References: [PostgreSQL explicit/advisory locks](https://www.postgresql.org/docs/18/explicit-locking.html),
[lock_timeout](https://www.postgresql.org/docs/18/runtime-config-client.html#GUC-LOCK-TIMEOUT),
[node-postgres transaction connection requirements](https://node-postgres.com/features/transactions).
