# Integrated resource and upgrade acceptance — 2026-11-14

The fresh full platform upgrade passed at exact frozen source
`9e6daefe53128e87e74003af6bc7562ab2eb8a39`, upgrading from `0.23.0`.
The successful VM `kayra-resource-acceptance-20261114200226` was destroyed.
This is experimental HTTP/migration/resource evidence, not completion of the
recoverable rollout integration.

| Case | Short requests | Failed requests | Premature exposure | Additional result |
|---|---:|---:|---:|---|
| Migration interruption and recovery | 2,969 | 0 | 0 | Original operation recovered |
| Candidate container OOM | 2,457 | 102 | 0 | Automatic verified recovery in 37.658 s |
| Concurrent admission and coordinator restart | 3,026 | 0 | — | One winner start; zero loser workload objects |
| Bounded lifecycle-journal ENOSPC and restart | 2,372 | 0 | 0 | One candidate start after space returned |

Each observer achieved approximately 20 requests/s, split between fresh and
persistent connections, with two-second short-request timeouts and no retries.
The OOM case's first failed request start to last failed completion spanned
7.049 seconds; this sampled interval is not an exact continuous outage duration.
Its recovery time starts at the native OOM event and ends at verified restoration
of the previous release. **This rollback was disruptive.** The failed candidate
was never promoted to active release.

The complete run also passed the ordinary Compose deployment, cached rebuild,
policy refusal, rollback, registry GC and final verification paths; TLS/Authelia;
mixed Compose/Swarm routing; read-only discovery API checks; the 79 component
scenarios; immutable-image admission; migration outcome recovery; and current
runtime-health observation. The negative inherited-volume image was refused
before workload mutation. Detailed raw logs remain authoritative for each case.

## Versions and reproduction

Ubuntu 24.04.5 LTS ARM64; 2 CPUs, 4 GiB RAM, 20 GiB disk. Docker Engine/CLI
29.9.3 (API 1.56), Compose 5.7.1, Node 24.22.1. The fleet reserves platform
capacity independently of application admission.

- Traefik: `traefik:v3.7.16@sha256:c8a121e4bb1347e8fd52657fab12f2cb70b68f8a018895e2068f92c9e519b9c2`
- Socket proxy: `tecnativa/docker-socket-proxy:v0.5.0@sha256:1f5038b54f06c3e18422902cf00ba21803d1c97805aae032e5e6673d532d3459`
- Fixture base: `node:24.22.1-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea`

From an immutable checkout of the source above, with the documented lab tools:

```bash
bash test/lab/upgrade.sh --from 0.23.0 \
  --vm-name "kayra-resource-acceptance-$(date -u +%Y%m%d%H%M%S)" \
  --indexed-registration --swarm-host
```

Keep the host awake for the run. The harness records clock offsets before and
after timed observers. This run used independent detached Git metadata, so later
worktree edits cannot change its reported source. Each observer's archive retains
source hashes, per-request results, Docker events, runtime observations and
resource samples. Fixture Git bundles and raw upgrade logs were also retained.

Private persistent evidence is in
`.cache/lab-evidence/kayra-resource-acceptance-20261114200226/`, with SHA-256/size
manifest and exact source identity. The retained inner raw upgrade log was
`/tmp/kayra-upgrade-kayra-resource-acceptance-20261114200226.1IDlVD/lab.log`.
`RESOURCE-RESULTS.json` records selected results without secret material.
Earlier failed attempts remain failed and preserved separately; this fresh run
validates the corrected harness as a whole.

## Limits

ENOSPC applies to a bounded 64 MiB ext4 filesystem for lifecycle metadata,
with an independent deployer-UID write proving exhaustion. It does not establish
Docker-root/inode exhaustion, app-data, host reboot or host-loss recovery.
Container OOM is not global OOM acceptance. No multi-node guarantee is implied.

Later volume adapter primitives and independent data-owner metadata are absent
from this source. Retained dependency integration, workers, singleton handoffs,
maintenance rollouts, application-wide compensation, removal/purge, and remaining
client/lifecycle acceptance still need implementation and native testing.
