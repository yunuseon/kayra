# Worker and singleton feasibility lab

Run from the Kayra checkout with Node 24, Multipass, Ansible and SSH installed:

```bash
bash test/lab/swarm/run.sh --suite workers --repeats 1 # six-case harness smoke
bash test/lab/swarm/run.sh --suite workers             # six cases × three repeats
bash test/lab/swarm/run.sh --suite workers --scenario singleton-locked --keep
node test/lab/swarm/workers/results.mjs .cache/swarm-worker-lab/RUN
```

Uses the shared Swarm lab bootstrap: a fresh Ubuntu 24.04 VM (2 CPUs, 4 GiB,
20 GB), Kayra Docker role, pinned images, read-only socket proxy, Docker event
and resource collection. Reuses the migration lab's pinned PostgreSQL 18 image
and locked pg dependencies. It builds the database fixture first, then a
separate worker image. Only lab-owned services and database tables change.
The existing `test` VM and host Docker context are untouched. Keep the Mac awake
with its lid open during measurement. Successful VMs are destroyed unless
`--keep`; failures preserve the VM and print cleanup instructions.

Each case starts a one-replica worker with start-first updates and 30-second
shutdown grace. A 30-second singleton baseline precedes the matrix. Queues have
20 jobs, a four-second renewable lease, and monotonically increasing attempt
tokens. Claims use `FOR UPDATE SKIP LOCKED`; effects check lease ownership under
a row lock. Effects and acknowledgements deliberately commit separately.

| Scenario | Injection | Required evidence |
|---|---|---|
| graceful-drain | Update while A owns a 20-second job | A completes it after B starts; clean exit; 20 single attempts and effects |
| killed-worker | SIGKILL exact A task after claim | Exit 137; expired lease redelivered; all jobs/effects retained within 90 seconds |
| effect-idempotent | SIGKILL after effect commit, before acknowledgement | Two target attempts, one target durable effect via unique key |
| effect-without-idempotency | Same crash without unique effect key | Negative control: two target durable effects |
| singleton-locked | Update while A holds session advisory lock | B is healthy standby, then owns; zero ownership overlap despite process overlap |
| singleton-unlocked | Same update without advisory lock | Negative control: both tasks perform exclusive work during overlapping ownership |

Singletons retain ownership through a deliberate five-second in-flight operation
on SIGTERM. Health indicates a live process, including standby; requiring exclusive
ownership before readiness could deadlock a start-first rollout. Intervals and
work ticks use the database clock. Raw evidence includes jobs, effects, event
history, intervals, ticks, service/task/container state, logs, Docker events and
VM/container telemetry. An observer restart can replay results from evidence.
Telemetry gaps over 15 seconds invalidate timing evidence.

These are application fixture protocols, not a production Kayra queue, app
contract or automatic conversion of existing apps. A unique PostgreSQL effect
key does not deduplicate an external API call; advisory locks do not fence an
external resource after losing the database session. No network partitions,
database failover, multi-node scheduling, real queue implementations, resource
admission or storage-retention guarantees are established here. Negative-control
PASS means the unsafe behavior was demonstrated.

Sources: [Docker update overlap](https://docs.docker.com/reference/compose-file/deploy/#update_config),
[PostgreSQL queue locking](https://www.postgresql.org/docs/18/sql-select.html),
[application advisory locks](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS).
