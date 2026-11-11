# Explicit Swarm host setup lab

Run the full upgrade scenario on a fresh disposable Multipass VM:

```bash
bash test/lab/upgrade.sh --from 0.23.0 --swarm-host --indexed-registration \
  --vm-name kayra-swarm-platform-unique
```

`--swarm-host` adds the fleet's explicit `experimental_swarm` profile after the
normal Compose upgrade, rollback, GC and polling checks. It verifies check mode
leaves Swarm inactive, then provisions one manager and an owned attachable
overlay through the platform role. A second reconciliation must report no
change. Existing Swarms and unrelated networks are refused; owned cluster and
network identities are recorded before publication. Interrupted acknowledgements
are reconciled without reinitializing a cluster. Host profile changes or removal
of this setting after setup require a future explicit maintenance/retirement
operation; setup never leaves a Swarm or recreates lost owned infrastructure.

Traefik keeps its Compose provider and gains the Swarm provider at the normal
refresh interval. The socket proxy adds SERVICES, TASKS, NETWORKS and NODES read
endpoints; POST remains disabled. No new service holds the Docker socket.

The probe creates one disposable, budgeted HTTP fixture through Docker directly,
using an existing fixture image by digest. It publishes no application port and
uses service VIP discovery. It verifies both Compose and Swarm routes with real
TLS, tests discovery GETs and denied POST/DELETE requests, removes its successful
fixture and records exact OS, Engine, CLI, Compose and pinned image versions.
This proves platform connectivity only. It does not exercise the coordinator's
application adapter, admission or a rollout, and does not establish continuity.

The machine-readable result survives successful VM cleanup at
`/tmp/kayra-swarm-platform-<vm-name>.json`. The upgrade script preserves failed
VMs and prints their fleet and cleanup command; `--keep` also retains successful
VMs. A failed probe leaves `kayra-lab-platform-http` for inspection, with
`io.kayra.lab=swarm-platform` and the owned node ID labels. Removing the disposable
VM cleans up that fixture as well.
