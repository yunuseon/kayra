/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- fixture owns transport responses, clock and caller mutation probes */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseManagedServicePlan, managedServiceName, managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import { ownedVolume } from "../../src/contracts/owned-volume.ts";
import type { ManagedServiceAction } from "../../src/contracts/managed-swarm-service.ts";
import type { VolumeObservation } from "../../src/contracts/owned-volume.ts";
import { managedSwarmService, renderNativeManagedService } from "../../src/server/runtime/managed-swarm-service.ts";
import { dockerApi } from "../../src/server/runtime/docker-api.ts";

const fixture = () => {
  const owner = { version: 1, app: "shop", incarnation: randomUUID(), dataOwner: randomUUID() } as const;
  const volume = ownedVolume(owner.app, owner.dataOwner, randomUUID(), "data"); assert.ok(volume.ok);
  const parsed = parseManagedServicePlan({ version: 1, runtime: "swarm", owner, service: "worker", nativeName: managedServiceName(owner, "worker"), role: "worker", overlap: "forbidden", handoffCheck: null,
    image: "localhost:5000/shop/worker@sha256:" + "a".repeat(64), inputs: { version: 1, registration: { version: 1, app: "shop", incarnation: owner.incarnation, actionId: owner.incarnation + ":1", registrationGeneration: randomUUID() }, configurationIdentity: "sha256:" + "b".repeat(64), environment: { TOKEN: { kind: "secret", key: "TOKEN" }, RELEASE: { kind: "literal", value: "A" } } },
    command: ["node", "/worker.js"], entrypoint: null, resources: { memoryBytes: 134217728, reserveMemoryBytes: 67108864, nanoCpus: 250000000, reserveNanoCpus: 125000000 },
    health: { command: ["node", "/health.js"], intervalSeconds: 2, timeoutSeconds: 1, startPeriodSeconds: 5, retries: 2 }, stopGraceSeconds: 30,
    host: { node: "n".repeat(25), cluster: "c".repeat(25), routingNetwork: null }, privateNetwork: { id: "p".repeat(25), name: `kayra-app-${owner.incarnation}` },
    mounts: [{ volume: volume.value, target: "/data", readOnly: false, noCopy: true }], dependencies: [],
  }); assert.ok(parsed.ok); const plan = parsed.value;
  const action: ManagedServiceAction = { app: owner.app, service: plan.service, incarnation: owner.incarnation, dataOwner: owner.dataOwner, action: owner.incarnation + ":2", plan: managedServiceDigest(plan), deadline: 91000, effect: "apply" };
  const receipt = { volume: volume.value, createdAt: "2026-11-15T12:00:00Z" }; const inputs = { environment: { RELEASE: "A", TOKEN: "PRIVATE-TOKEN" }, routing: {}, volumes: [receipt] };
  const spec = renderNativeManagedService(plan, action, inputs); const id = "s".repeat(25); const version = { id, version: 42 };
  let now = 1000; let actual: unknown = { ID: id, Version: { Index: 100 }, Spec: spec, UpdateStatus: { State: "completed" } }; let exists = true;
  let observation: VolumeObservation = { status: "owned", receipt }; let volumeReads = 0; const calls: { method: string; path: string; body: unknown }[] = [];
  const api: ReturnType<typeof dockerApi> = { request: (method, path, body) => {
    calls.push({ method, path, body });
    if (method === "GET") return Promise.resolve(path.startsWith("/services/") ? { status: exists ? 200 : 404, value: actual } : { status: 200, value: [] });
    assert.equal(method, "POST"); return Promise.resolve({ status: exists ? 200 : 201, value: null });
  } };
  const observer = { observe: () => { volumeReads += 1; return Promise.resolve(observation); } };
  return { owner, plan, action, inputs, receipt, spec, id, version, calls, api, observer, now: () => now, adapter: managedSwarmService(api, observer, () => now),
    setTime: (time: number) => { now = time; }, setService: (value: unknown) => { actual = value; }, absent: () => { exists = false; }, volume: (value: VolumeObservation) => { observation = value; }, volumeReads: () => volumeReads };
};

test("managed rendering pins private DNS, placement and owned mounts, with declared stop-first updates", () => {
  const f = fixture(); assert.equal(f.spec.Name, f.plan.nativeName); assert.equal(f.spec.Labels["com.kayra.data-owner"], f.owner.dataOwner);
  assert.deepEqual(f.spec.TaskTemplate.Networks, [{ Target: f.plan.privateNetwork.id, Aliases: ["worker"] }]);
  assert.deepEqual(f.spec.TaskTemplate.ContainerSpec.Mounts, [{ Type: "volume", Source: f.receipt.volume.name, Target: "/data", VolumeOptions: { NoCopy: true } }]);
  assert.deepEqual(f.spec.TaskTemplate.Placement.Constraints, ["node.id==" + f.plan.host.node]); assert.equal(f.spec.TaskTemplate.ContainerSpec.StopGracePeriod, 30e9);
  assert.deepEqual(f.spec.TaskTemplate.ContainerSpec.Healthcheck.Test, ["CMD", "node", "/health.js"]); assert.equal(f.spec.UpdateConfig.Order, "stop-first"); assert.equal(f.spec.RollbackConfig.Order, "stop-first");
});

test("HTTP and coordinated singleton updates use start-first while HTTP alone joins the routing overlay", () => {
  const f = fixture();
  for (const role of ["http", "singleton"] as const) {
    const parsed = parseManagedServicePlan({ ...f.plan, role, overlap: role === "http" ? "allowed" : "coordinated", handoffCheck: role === "singleton" ? "handoff" : null, host: { ...f.plan.host, routingNetwork: role === "http" ? "r".repeat(25) : null } }); assert.ok(parsed.ok);
    const routing = role === "http" ? { "traefik.enable": "true", "traefik.swarm.network": "platform-swarm", "traefik.swarm.lbswarm": "true" } : {};
    const spec = renderNativeManagedService(parsed.value, { ...f.action, plan: managedServiceDigest(parsed.value) }, { ...f.inputs, routing });
    assert.equal(spec.UpdateConfig.Order, "start-first"); assert.equal(spec.TaskTemplate.Networks.length, role === "http" ? 2 : 1);
    assert.equal(spec.UpdateConfig.Monitor, 30e9);
  }
});

test("managed effects verify recorded creation evidence then use the exact persisted CAS once", async () => {
  const f = fixture(); assert.equal(await f.adapter.apply(f.action, f.version, f.plan, f.inputs), "acknowledged"); assert.equal(f.volumeReads(), 1);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0]?.method, "GET"); assert.equal(f.calls[1]?.path, `/services/${f.id}/update?version=42`); assert.deepEqual(f.calls[1].body, f.spec);
  f.calls.length = 0; f.absent(); assert.equal(await f.adapter.apply(f.action, null, f.plan, f.inputs), "acknowledged"); assert.equal(f.calls[1].path, "/services/create");
});

test("missing, replaced or foreign volumes refuse before workload Docker reads or writes", async () => {
  const f = fixture();
  for (const observation of [{ status: "absent" }, { status: "foreign" }, { status: "unavailable" }, { status: "owned", receipt: { ...f.receipt, createdAt: "2026-11-15T13:00:00Z" } }] as const) {
    f.volume(observation); assert.equal(await f.adapter.apply(f.action, f.version, f.plan, f.inputs), "refused");
  }
  assert.equal(f.calls.length, 0);
  assert.equal(await f.adapter.apply(f.action, f.version, f.plan, { ...f.inputs, volumes: [] }), "refused"); assert.equal(f.calls.length, 0);
});

test("ordinary replacement cannot update or restart an existing retained dependency", async () => {
  const f = fixture(); const parsed = parseManagedServicePlan({ ...f.plan, role: "retained-dependency" }); assert.ok(parsed.ok);
  const action = { ...f.action, plan: managedServiceDigest(parsed.value) };
  assert.equal(await f.adapter.apply(action, f.version, parsed.value, f.inputs), "refused"); assert.equal(f.calls.length, 0); assert.equal(f.volumeReads(), 0);
  f.absent(); assert.equal(await f.adapter.apply(action, null, parsed.value, f.inputs), "acknowledged"); assert.equal(f.calls[1]?.path, "/services/create");
});

test("expired writes and wrong owner, digest, environment or routing cannot mutate workloads", async () => {
  const f = fixture(); f.setTime(f.action.deadline);
  assert.equal(await f.adapter.apply(f.action, f.version, f.plan, f.inputs), "refused"); f.setTime(1000);
  for (const action of [{ ...f.action, dataOwner: randomUUID() }, { ...f.action, plan: "f".repeat(64) }]) assert.equal(await f.adapter.apply(action, f.version, f.plan, f.inputs), "refused");
  assert.equal(await f.adapter.apply(f.action, f.version, f.plan, { ...f.inputs, environment: { ...f.inputs.environment, RELEASE: "changed" } }), "refused");
  assert.equal(await f.adapter.apply(f.action, f.version, f.plan, { ...f.inputs, routing: { "traefik.enable": "true" } }), "refused"); assert.equal(f.calls.length, 0);
});

test("fresh readonly desired observations remain available after effect expiry without granting another write", async () => {
  const f = fixture(); f.setTime(100000);
  const observed = await f.adapter.observeDesired(f.action, f.plan, f.inputs); assert.equal(observed.status, "owned");
  assert.equal(observed.specMatches, true); assert.equal(JSON.stringify(observed).includes("PRIVATE"), false); assert.ok(f.calls.every((call) => call.method === "GET"));
  assert.equal(await f.adapter.apply(f.action, f.version, f.plan, f.inputs), "refused");
});

test("desired verification refuses native bind/driver/privilege drift while accepting harmless volume defaults", async () => {
  const f = fixture(); const container = f.spec.TaskTemplate.ContainerSpec; const mount = container.Mounts?.[0]; assert.ok(mount);
  for (const replacement of [ { ...mount, Type: "bind" }, { ...mount, VolumeOptions: { NoCopy: true, DriverConfig: { Name: "local", Options: { device: "/etc" } } } }, { ...mount, Source: "unrelated-volume" } ]) {
    f.setService({ ID: f.id, Version: { Index: 100 }, Spec: { ...f.spec, TaskTemplate: { ...f.spec.TaskTemplate, ContainerSpec: { ...container, Mounts: [replacement] } } } });
    const observed = await f.adapter.observeDesired(f.action, f.plan, f.inputs); assert.equal(observed.status, "owned"); assert.equal(observed.specMatches, false);
  }
  f.setService({ ID: f.id, Version: { Index: 100 }, Spec: { ...f.spec, TaskTemplate: { ...f.spec.TaskTemplate, ContainerSpec: { ...container, Mounts: [{ ...mount, ReadOnly: false, VolumeOptions: { NoCopy: true, Labels: null, DriverConfig: null } }] } } } });
  const observed = await f.adapter.observeDesired(f.action, f.plan, f.inputs); assert.equal(observed.status, "owned"); assert.equal(observed.specMatches, true);
});

test("materialized inputs are snapshotted before asynchronous volume observations", async () => {
  const f = fixture(); const inputs = { ...f.inputs, environment: { ...f.inputs.environment }, volumes: [...f.inputs.volumes] };
  const adapter = managedSwarmService(f.api, { observe: () => { inputs.environment.TOKEN = "CHANGED-PRIVATE"; inputs.volumes[0] = { ...f.receipt, createdAt: "2026-11-15T13:00:00Z" }; return Promise.resolve({ status: "owned", receipt: f.receipt }); } }, f.now);
  assert.equal(await adapter.apply(f.action, f.version, f.plan, inputs), "acknowledged"); assert.deepEqual(f.calls[1]?.body, f.spec);
});
