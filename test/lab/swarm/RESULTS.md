# Swarm experiment status — 2026-10-26

**Incomplete: no corrected, uninterrupted 36-case matrix is available.**
Do not select a runtime from these measurements. The harness is implemented;
the remaining task is a complete run while its host remains awake.

## Measured environment

Ubuntu 24.04.5 LTS, ARM64, kernel 6.8.0-147-generic; 2 CPUs, 4 GB RAM,
20 GB disk. Docker Engine and CLI 29.9.2 (API 1.56), Compose 5.6.1.
Images were taken from Kayra's digest pins:

| Image | Digest |
|---|---|
| Traefik v3.7.16 | `sha256:c8a121e4bb1347e8fd52657fab12f2cb70b68f8a018895e2068f92c9e519b9c2` |
| Socket proxy v0.5.0 | `sha256:1f5038b54f06c3e18422902cf00ba21803d1c97805aae032e5e6673d532d3459` |
| Node 24.22.1 trixie slim | `sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea` |

The proxy's discovery read returned 200 and its attempted API write returned
403. No provider refresh override or request retries were configured.
Each run records its exact commit, source hashes, image IDs, versions and commands.

## Preliminary observations

These individual observations do not substitute for the final comparison:

| Diagnostic | Observation |
|---|---|
| Task-address discovery, 15-second readiness delay | 90/1,597 short requests failed; no premature exposure; native update completed. Actual task backend addresses were verified in access logs. |
| VIP discovery, verified post-health crash | Automatic rollback completed in 23.331 s; HTTP settled in 23.377 s; 82/1,149 short requests failed; longest sampled consecutive failure interval 4.226 s. |

The focused VIP case (`20261026t074458286`, measured commit
`496cd485879e15d3210065534bd147cab3c7fd26`) had a Docker healthy event
5.143 s before the injected exit 42. Its access logs proved service-VIP
routing and zero proxy retries, and it contained 30.913 s of stable recovery.
This is **disruptive recovery**, not uninterrupted rollback. Its minimal VM
peaked at 583.42 MiB used memory and 14.55% CPU; these are not platform sizing
estimates.

The task-address observation is from `20261026t074817122`, the same measured
commit. That run was stopped to distinguish native runtime completion from
HTTP recovery. Earlier full-matrix diagnostics had incomplete rotated proxy
logs and an unverified fault phase, so they cannot establish viability.

The latest run (`20261026t154338463`, commit
`1f8d70c999797704397f6f3282988e3b7935ba62`) was invalidated by host sleep:
its request stream paused for 273.851 s, corroborated by macOS power logs.
Multipass and its deadlines paused too. This is an infrastructure failure,
not a failed healthy-replacement result. The harness now rejects sampling
gaps over one second or average traffic below 18 requests/s.

## Reproduction and decision

From this checkout on a host that will stay awake for about an hour:

```bash
node --test test/lab/swarm/lab.test.mjs
bash test/lab/swarm/run.sh --output /tmp/kayra-swarm-comparison
node test/lab/swarm/analyze.mjs /tmp/kayra-swarm-comparison
```

The README describes focused runs and all raw artifacts. Failed labs are
preserved and print their exact cleanup commands; successful labs are deleted
unless `--keep` is supplied. Diagnostic VMs have been stopped, retaining their
disks. Neither the existing `test` VM nor the host OrbStack context was changed.

Complete all 18 cases per mode before deciding. If one mode meets the agreed
continuity and recovery criteria, advance only to migration, worker, singleton,
admission and retention experiments. If neither passes, run a comparable K3s
experiment. HTTP routing alone establishes neither database rollback safety
nor recovery of Kayra release records, TLS, full-platform overhead or multi-node
availability.
