# Persistent infrastructure and upgrade acceptance — 2026-11-15

The fresh full upgrade passed at frozen source
`1e32190c0fad2cf2eebf8f58239a22196d4b629a`, upgrading from `0.23.0`.
Successful VM `kayra-infra-upgrade-20261115131133` was destroyed. The new
registration published a private physical overlay grant and retained it after
recreating the deployer container. The lab checked the private UID/GID-1000
`0700` host directory and exact writable platform-state bind. The builder has
no such bind or Docker access.

| Integrated case | Requests | Failed | Premature exposure | Observation |
|---|---:|---:|---:|---|
| Migration interruption/recovery | 2,990 | 0 | 0 | Original jobs recovered; one status probe |
| Candidate container OOM | 2,482 | 110 | 0 | Previous release verified in 37.329 s |
| Concurrent admission/restart | 3,053 | 0 | — | Winner started once; loser created no workloads |
| Bounded journal ENOSPC/restart | 2,418 | 0 | 0 | Original identity/deadline; one candidate start |

Observers achieved approximately 20 requests/s, split between fresh and
persistent connections, with two-second short-request timeouts and no retries.
**OOM rollback was disruptive.** Its failed-request span was 7.400 seconds from
first failure start to last failure completion. That sampled span is not an
exact continuous outage duration. Verified recovery is measured from the native
OOM event. The failed candidate was not promoted.

The full run also passed Compose deployment/restore/cache/policy/rollback/GC,
TLS/Authelia, mixed runtime routing, read-only Swarm discovery (writes refused),
native component recovery tests, inherited-volume image refusal, current versus
historical task health, and final platform verification. Raw logs are retained.

## Versions and reproduction

Ubuntu 24.04.5 LTS ARM64, kernel `6.8.0-147-generic`; 2 CPUs, 4G RAM, 20G disk.
Engine/CLI 29.9.3, API 1.56, Compose 5.7.1, Node 24.22.1. Exact Traefik and
socket-proxy digests and selected measurements are in
[INFRASTRUCTURE-RESULTS.json](./INFRASTRUCTURE-RESULTS.json).

From a detached immutable checkout of the source above:

```bash
bash test/lab/upgrade.sh --from 0.23.0 \
  --vm-name "kayra-infra-upgrade-$(date -u +%Y%m%d%H%M%S)" \
  --indexed-registration --swarm-host
```

Keep the host awake. Private evidence, including the raw upgrade log, source
hashes, clock checks, exact versions, request results, Docker events and resource
samples, is retained in
`.cache/lab-evidence/kayra-infra-upgrade-20261115131133/` with
`SHA256SUMS.json`. Earlier failed attempts remain failed and preserved.

This source predates the owned managed runtime extraction (#300), transition
admission (#301) and managed migration binding (#302); this run does not validate
those changes. Managed groups remain disabled. Integrated retained dependencies,
workers, singleton handoff, maintenance, lifecycle removal/recreation and purge
remain acceptance work. Bounded metadata ENOSPC does not establish Docker-root,
inode, global OOM, host-loss or multi-node safety.
