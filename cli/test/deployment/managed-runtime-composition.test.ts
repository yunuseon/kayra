/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types -- records independent native, authority and private-input ports */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { parseManagedLifecycleSource, managedLifecycleDescription, managedLifecycleSourceDigest } from "../../src/server/deployment/managed-lifecycle-source.ts";
import { parseManagedExecutionContext } from "../../src/contracts/managed-execution-context.ts";
import { managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import { managedRuntime } from "../../src/server/composition/managed-runtime.ts";
import { serviceInputValues } from "../../src/server/platform/service-inputs.ts";
import type { ManagedSwarmServicePort, ManagedServiceInputs } from "../../src/contracts/managed-swarm-service.ts";
import type { ManagedRuntimePermission } from "../../src/contracts/managed-runtime-authority.ts";
import type { JobPort } from "../../src/contracts/one-shot-job.ts";
import type { ManagedChecksPort } from "../../src/contracts/container-check.ts";
import type { OwnedVolume } from "../../src/contracts/owned-volume.ts";
import { typed } from "../../src/lib/typed.ts";

const fixture = async () => {
  const { plan } = await managedPlanFixture(); const source = parseManagedLifecycleSource({ version: 2, candidate: plan, previous: null, retained: [], retired: [], run: randomUUID(), action: plan.infrastructure.ownership.incarnation + ":2", createdAt: 1000 }); const description = managedLifecycleDescription(source);
  const parsed = parseManagedExecutionContext({ version: 1, protocol: "managed-v3", runtime: "swarm", owner: plan.infrastructure.ownership, run: source.run, action: source.action, source: managedLifecycleSourceDigest(source), application: plan, previous: null, allocationRequired: true, createdAt: source.createdAt, admissionDeadline: description.admissionDeadline, deadline: description.deadline }); assert.ok(parsed.ok); const context = parsed.value;
  const effects: string[] = []; const permissions: ManagedRuntimePermission[] = []; const inputs: ManagedServiceInputs[] = []; let reads = 0; let creationAllowed = true;
  const services = typed<ManagedSwarmServicePort>({ observe: () => { effects.push("observe"); return Promise.resolve({ status: "absent" }); }, observeDesired: (_, __, value) => { inputs.push(value); effects.push("desired"); return Promise.resolve({ status: "absent" }); }, apply: (_, __, ___, value) => { inputs.push(value); effects.push("apply"); return Promise.resolve("acknowledged"); }, reactivate: () => Promise.resolve("acknowledged"), fence: () => { effects.push("fence"); return Promise.resolve("acknowledged"); }, tombstone: () => { effects.push("tombstone"); return Promise.resolve("acknowledged"); } });
  const jobs = typed<JobPort>({ observe: () => Promise.resolve({ status: "absent" }), create: () => Promise.resolve("acknowledged"), start: () => Promise.resolve("acknowledged"), fence: () => Promise.resolve("acknowledged") });
  const checks = typed<ManagedChecksPort>({ select: () => Promise.resolve({ status: "unavailable" }), create: () => Promise.resolve({ status: "refused" }), start: () => Promise.resolve("refused"), observe: () => Promise.resolve({ status: "unavailable" }) });
  const environment = serviceInputValues((reference) => { reads++; return Promise.resolve({ configurationIdentity: reference.configurationIdentity, configuration: { MODE: "synthetic-config" }, secrets: { TOKEN: "synthetic-private-token" }, secretKeys: ["TOKEN"] }); });
  const ports = { read: () => Promise.resolve(""), retain: () => Promise.resolve(""), now: () => 1000, observeHost: () => Promise.resolve({ status: "unavailable" as const }), environment,
    receipts: { read: (values: readonly OwnedVolume[]) => Promise.resolve(values.map((volume) => ({ volume, createdAt: new Date(1000).toISOString() }))) },
    authority: { allowed: (_context: typeof context, permission: ManagedRuntimePermission) => { permissions.push(permission); return Promise.resolve(permission.kind === "service" ? true : creationAllowed); } },
    native: { services, jobs, checks, volumes: { observe: () => Promise.resolve({ status: "absent" as const }), create: () => Promise.resolve("acknowledged" as const) }, readiness: { check: (action: Parameters<NonNullable<ReturnType<typeof managedRuntime>["readiness"]>["check"]>[0]) => Promise.resolve({ app: action.app, incarnation: action.incarnation, service: action.service, action: action.action, plan: action.plan, checkedAt: 1000, status: "ready" as const }) } },
  };
  const web = plan.services["web"]; assert.ok(web); const action = { app: context.owner.app, incarnation: context.owner.incarnation, dataOwner: context.owner.dataOwner, service: "web", action: source.action, effect: "apply" as const, plan: managedServiceDigest(web), deadline: 91000 };
  return { source, context, ports, effects, inputs, permissions, action, web, reads: () => reads, deny: () => { creationAllowed = false; } };
};

test("runtime factory binds source authority and supplies private materialization without effects during construction", async () => {
  const lab = await fixture(); const runtime = managedRuntime(lab.context, lab.ports); assert.deepEqual(lab.effects, []); assert.equal(lab.reads(), 0);
  assert.equal(await runtime.requestAllowed(lab.source), true); assert.equal(await runtime.authorize(lab.source, { kind: "allocation" }), true);
  assert.equal(await runtime.services.apply(lab.action, null, lab.web, lab.context.application), "acknowledged"); assert.equal(lab.inputs[0]?.environment["TOKEN"], "synthetic-private-token"); assert.equal(lab.reads(), 1);
  assert.equal(JSON.stringify(lab.context).includes("synthetic-private-token"), false); assert.deepEqual(lab.permissions.slice(0, 2), [{ kind: "admission" }, { kind: "allocation" }]); assert.ok(runtime.managedData);
});

test("another source, action sequence, application or owner cannot borrow the factory's effects or private inputs", async () => {
  const lab = await fixture(); const runtime = managedRuntime(lab.context, lab.ports); const other = parseManagedLifecycleSource({ ...lab.source, run: randomUUID() }); assert.equal(await runtime.requestAllowed(other), false); assert.equal(await runtime.authorize(other, { kind: "recovery" }), false);
  assert.equal(await runtime.services.apply({ ...lab.action, action: lab.context.owner.incarnation + ":3" }, null, lab.web, lab.context.application), "refused");
  assert.equal(await runtime.services.apply(lab.action, null, lab.web, { ...lab.context.application, commit: "f".repeat(40) }), "refused");
  assert.deepEqual(await runtime.services.observe({ ...lab.action, dataOwner: randomUUID() }), { status: "foreign" }); assert.deepEqual(lab.effects, []); assert.equal(lab.reads(), 0); assert.deepEqual(lab.permissions, []);
});

test("revoked creation permission prevents private access while separate native cleanup permission remains usable", async () => {
  const lab = await fixture(); const runtime = managedRuntime(lab.context, lab.ports); lab.deny(); assert.equal(await runtime.services.apply(lab.action, null, lab.web, lab.context.application), "refused"); assert.equal(lab.reads(), 0);
  const fence = runtime.services.fence; assert.ok(fence); assert.equal(await fence({ ...lab.action, effect: "fence" }, { id: "s".repeat(25), version: 1 }), "acknowledged"); assert.deepEqual(lab.effects, ["fence"]);
});

test("a stalled authority read is bounded and its late approval cannot grant an effect", async (t) => {
  const lab = await fixture(); t.mock.timers.enable({ apis: ["setTimeout"] }); const entered = Promise.withResolvers<undefined>(); const grant = Promise.withResolvers<boolean>();
  const runtime = managedRuntime(lab.context, { ...lab.ports, authority: { allowed: () => { entered.resolve(undefined); return grant.promise; } } });
  const allowed = runtime.requestAllowed(lab.source); await entered.promise; t.mock.timers.tick(10000); assert.equal(await allowed, false); grant.resolve(true); await Promise.resolve(); assert.deepEqual(lab.effects, []); assert.equal(lab.reads(), 0);
});
