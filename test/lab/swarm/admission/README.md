# Admission and data-retention experiment

```bash
bash test/lab/swarm/run.sh --suite admission --repeats 1
bash test/lab/swarm/run.sh --suite admission
node test/lab/swarm/admission/results.mjs .cache/swarm-admission-lab/RUN
```

Uses the shared fresh Ubuntu 24.04 Multipass VM bootstrap (2 CPUs, 4 GB RAM,
20 GB disk), Docker role, pinned Traefik/socket proxy/Node/PostgreSQL, VIP
routing, Docker events and resource collectors. Existing VMs and host Docker
context are untouched. Keep the Mac awake with its lid open. Successful VMs
are destroyed unless `--keep`; failed labs are preserved with cleanup commands.

A 30-second healthy baseline precedes six cases, each repeated three times.
Traffic is 20 requests/s, split fresh/persistent connections, no retries,
two-second deadlines. Each successful response acknowledges a committed database
write and verifies database/file canaries. All cases require zero request
failures, zero premature candidate exposure, all acknowledged values retained,
an unchanged 1 MiB random file hash, actual VIP routing without retries and a
30-second stable A tail after the outcome.

| Case | Injection and required evidence |
|---|---|
| memory-reservation | Filler reserves enough memory to prevent A/B overlap and touches more than 2 GiB. B stays pending beyond the 30-second failure monitor; A serves. Lab explicitly cancels at 35 seconds and restores A. |
| candidate-oom | B allocates beyond a 128 MiB limit before readiness. Docker OOM/exit-137 evidence, native automatic rollback, no B traffic. |
| disk-admission | Exhaust a bounded 256 MiB ext4 filesystem. Lab policy requires 64 MiB free and refuses before service mutation. A serves normally. |
| candidate-enospc | B bypasses that policy, attempts a write on the exhausted filesystem, exits 42 with ENOSPC before readiness, and automatically rolls back. |
| retention-lifecycle | B acknowledges writes; manual rollback restores A; never-ready update rolls back. After continuity traffic stops, remove service, recreate PostgreSQL container with the same named volume, recreate A, and verify all data/files. |
| purge-guard | Existing app-purge script refuses while registered. After continuity traffic stops, remove app/database containers, unregister fixture, explicitly purge labelled volumes. Unrelated volume survives; PostgreSQL recreated on a new volume is empty. |

Raw evidence records every request, database row, file hash, admission decision,
service/task/container inspection, fault, lifecycle step, Docker event and
resource sample. Missing fault proof fails replay. Timing evidence is invalid
if traffic pauses or telemetry gaps exceed 15 seconds.

The filler combines scheduler reservations and bounded real memory pressure;
this is not a global kernel-OOM test. Disk exhaustion is confined to a loopback
filesystem, not Docker's own filesystem. The lab coordinator supplies disk
admission and the pending-update timeout; neither is a current Kayra feature.
Purge explicitly uses Compose-compatible ownership labels because the existing
script selects those labels. Native Swarm service removal models app removal;
Kayra's Compose app-remove integration is not validated. The lab does not change
production scripts, deployer behavior, or the app contract.

No claims cover admission races, resource prediction, global OOM, Docker-root
or inode exhaustion, backup/restore, host loss, multi-node volume placement,
TLS/Authelia or Kayra release-record recovery. Retention is persistence through
these lifecycle operations, not a backup or disaster recovery guarantee.

Sources: [Swarm reservations and pending updates](https://docs.docker.com/engine/swarm/services/),
[volume lifecycle](https://docs.docker.com/engine/storage/volumes/),
[pruning semantics](https://docs.docker.com/engine/manage-resources/pruning/).
