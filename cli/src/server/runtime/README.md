# Runtime effects

The runtime boundary owns Docker operations and normalized observations. It
receives validated immutable intent through typed ports; it owns no fleet
interpretation, rollout decisions, release promotion or notification policy.

- `compose.ts` preserves compatibility workload commands behind the runtime port.
- `swarm-host.ts` observes the explicitly provisioned single-node host.
- `swarm-service.ts` applies owned HTTP services with versioned native intent,
  observes actual tasks and fences superseded effects. Routing is supplied by
  the platform boundary; promotion and compensation belong to the coordinator.
- `one-shot-job.ts` creates and starts individually identified jobs without
  restart, then fences exact container IDs and retains inert name barriers.
  Materialized inputs exist only in its native create request. Status-probe
  output is bounded and normalized before crossing the observation port.
- `docker-api.ts` owns bounded, non-retrying transport. Raw response bytes are
  adapter temporaries, never journals or published reporting formats.

These modules share the existing trusted process through the composition root.
Their code boundaries establish no extra process isolation or socket holder.
The one-shot primitive is not a public lifecycle entrypoint and enables no
migration capability until the coordinator supplies admission and sequencing.

## Disconnected service renderer

`swarm.ts` is a disconnected pure renderer, not a runtime adapter that can
start or update a service. Nothing in the existing deployer calls it. It only
accepts a narrow, already-normalized description of a single rolling HTTP
workload. It does not parse or translate Compose, select an application's
runtime, make admission decisions, evaluate rollout compatibility or perform
Docker operations. Unsupported fields are rejected.

The caller must derive the registry, overlay name and Swarm network ID from
trusted platform configuration, and must have independently validated the
application's registration, rollout metadata, capabilities and ownership. The
fragment contains no route, TLS, auth or `traefik.enable` labels. The platform
must generate and validate routing policy separately before a workload can be
routed. With Traefik's `exposedByDefault=false`, this fragment is deliberately
not routable on its own. No app-supplied Docker or Traefik label is accepted.

The fragment specifies one replica, VIP endpoint mode, start-first update and
rollback, update failure rollback, a 30-second update and rollback monitor,
health check, shutdown grace and explicit resource budgets. Its overlay `Target`
is the platform-resolved network ID; the discovery hint is the network name.
Both are needed. It allows only digest-qualified images in the app's registry
namespace, a DNS-form registry authority with an optional valid TCP port, and
exec-form health checks. Before using the fragment, the adapter must verify
that the configured overlay name and ID identify the same platform-owned,
attachable Swarm network and that Traefik is attached. This pure renderer
cannot establish that relationship or check whether budgets are available.
It does not yet support environment,
secrets, volumes, dependencies, arbitrary commands, migrations, checks, workers,
singletons or maintenance. Those missing capabilities must fail admission, not
be silently dropped.

The isolated lab's recorded Docker ServiceSpec confirms the field shapes, VIP
mode, service-level discovery labels, and 30-second update monitor. The tested
lab service had a 5-second rollback monitor, no CPU limits and a shell-form
health check; this renderer's 30-second rollback monitor, CPU budgets and
exec-form check still need live integration testing. The lab did not exercise
this renderer, Kayra's platform routing or coordinator. A passing unit test is
not evidence of end-to-end continuity or production readiness.
