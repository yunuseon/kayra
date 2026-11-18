/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types -- records calls to independently injected input and native ports */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { managedWorkloads, managedWorkloadObservations } from "../../src/server/composition/managed-workloads.ts";
import { serviceInputValues } from "../../src/server/platform/service-inputs.ts";
import { managedServiceDigest } from "../../src/contracts/managed-service-plan.ts";
import type { ManagedSwarmServicePort, ManagedServiceInputs } from "../../src/contracts/managed-swarm-service.ts";
import type { OwnedVolume } from "../../src/contracts/owned-volume.ts";
import { err } from "../../src/lib/result.ts";
import { typed } from "../../src/lib/typed.ts";

const fixture = async () => {
  const { plan } = await managedPlanFixture(); let environmentReads = 0; let volumeReads = 0; let allowedReads = 0; let allowed = true;
  const calls: { readonly method: string; readonly inputs: ManagedServiceInputs }[] = [];
  const capture = (method: string, inputs: ManagedServiceInputs) => { calls.push({ method, inputs }); };
  const native = typed<ManagedSwarmServicePort>({ observe: () => Promise.resolve({ status: "absent" }), observeDesired: (_, __, inputs) => { capture("observe", inputs); return Promise.resolve({ status: "absent" }); },
    apply: (_, __, ___, inputs) => { capture("apply", inputs); return Promise.resolve("acknowledged"); }, reactivate: (_, __, ___, inputs) => { capture("reactivate", inputs); return Promise.resolve("acknowledged"); }, fence: () => Promise.resolve("acknowledged"), tombstone: () => Promise.resolve("acknowledged") });
  const materialize = serviceInputValues((reference) => { environmentReads++; return Promise.resolve({ configurationIdentity: reference.configurationIdentity, configuration: { MODE: "synthetic-config" }, secrets: { TOKEN: "synthetic-private-token" }, secretKeys: ["TOKEN"] }); });
  const ports = { environment: materialize, allowed: () => { allowedReads++; return Promise.resolve(allowed); }, volumes: { read: (volumes: readonly OwnedVolume[]) => { volumeReads++; return Promise.resolve(volumes.map((volume) => ({ volume, createdAt: "2026-11-18T00:00:00Z" }))); } } };
  const action = (service: string) => { const spec = plan.services[service]; assert.ok(spec); return { app: spec.owner.app, incarnation: spec.owner.incarnation, dataOwner: spec.owner.dataOwner, service, action: spec.owner.incarnation + ":2", plan: managedServiceDigest(spec), deadline: 91000, effect: "apply" as const }; };
  return { plan, native, ports, calls, action, counts: () => ({ environmentReads, volumeReads, allowedReads }), deny: () => { allowed = false; } };
};

test("managed composition keeps private materialization and recorded volume receipts at the native boundary", async () => {
  const lab = await fixture(); const runtime = managedWorkloads(lab.native, lab.ports); const web = lab.plan.services["web"]; const db = lab.plan.services["db"]; assert.ok(web && db);
  const before = JSON.stringify(lab.plan); assert.equal(await runtime.apply(lab.action("web"), null, web, lab.plan), "acknowledged");
  const first = lab.calls[0]; assert.ok(first); assert.equal(first.inputs.environment["TOKEN"], "synthetic-private-token"); assert.equal(first.inputs.environment["MODE"], "synthetic-config"); assert.equal(first.inputs.routing["traefik.swarm.lbswarm"], "true"); assert.equal(first.inputs.routing["traefik.swarm.network"], "platform-swarm"); assert.deepEqual(first.inputs.volumes, []);
  assert.equal(await runtime.apply(lab.action("db"), null, db, lab.plan), "acknowledged"); const receipt = lab.calls[1]?.inputs.volumes[0]; assert.ok(receipt); assert.deepEqual(receipt.volume, db.mounts[0]?.volume); assert.equal(receipt.createdAt, "2026-11-18T00:00:00Z"); assert.deepEqual(lab.calls[1]?.inputs.routing, {});
  assert.equal(JSON.stringify(lab.plan), before); assert.equal(before.includes("synthetic-private-token"), false); assert.equal(lab.counts().volumeReads, 1);
  const observations = managedWorkloadObservations({ observe: lab.native.observe, observeDesired: lab.native.observeDesired }, lab.ports); assert.deepEqual(Object.keys(observations).toSorted(), ["observe", "observeDesired"]);
  assert.deepEqual(await observations.observeDesired(lab.action("web"), web, lab.plan), { status: "absent" }); assert.equal(lab.calls.at(-1)?.method, "observe");
});

test("mismatched scopes and specifications are refused before private reads or native effects", async () => {
  const lab = await fixture(); const runtime = managedWorkloads(lab.native, lab.ports); const web = lab.plan.services["web"]; assert.ok(web);
  for (const action of [{ ...lab.action("web"), dataOwner: randomUUID() }, { ...lab.action("web"), plan: "f".repeat(64) }, { ...lab.action("web"), incarnation: randomUUID() }]) assert.equal(await runtime.apply(action, null, web, lab.plan), "refused");
  assert.equal(await runtime.apply(lab.action("web"), null, { ...web, inputs: { ...web.inputs, environment: {} } }, lab.plan), "refused"); assert.equal(lab.calls.length, 0); assert.deepEqual(lab.counts(), { environmentReads: 0, volumeReads: 0, allowedReads: 0 });
  lab.deny(); assert.deepEqual(await runtime.observeDesired(lab.action("web"), web, lab.plan), { status: "unavailable" }); assert.equal(lab.counts().environmentReads, 0);
});

test("missing recorded volumes and private failures never cause creation, workload writes or error disclosure", async () => {
  const lab = await fixture(); const db = lab.plan.services["db"]; const web = lab.plan.services["web"]; assert.ok(db && web);
  const noReceipt = managedWorkloads(lab.native, { ...lab.ports, volumes: { read: () => Promise.resolve(undefined) } }); assert.equal(await noReceipt.apply(lab.action("db"), null, db, lab.plan), "refused");
  const invalid = managedWorkloads(lab.native, { ...lab.ports, volumes: { read: () => Promise.resolve([]) } }); assert.deepEqual(await invalid.observeDesired(lab.action("db"), db, lab.plan), { status: "unavailable" });
  const failed = managedWorkloads(lab.native, { ...lab.ports, environment: { materialize: () => Promise.resolve(err("synthetic-private-token must not escape")) } }); assert.equal(await failed.apply(lab.action("web"), null, web, lab.plan), "refused");
  const unavailable = managedWorkloadObservations({ observe: lab.native.observe, observeDesired: () => Promise.reject(new Error("synthetic-private-token must not escape")) }, lab.ports); assert.deepEqual(await unavailable.observeDesired(lab.action("web"), web, lab.plan), { status: "unavailable" }); assert.equal(lab.calls.length, 0);
});


test("a permission change during materialization refuses the subsequent native call", async () => {
  const lab = await fixture(); let checks = 0; const web = lab.plan.services["web"]; assert.ok(web);
  const runtime = managedWorkloads(lab.native, { ...lab.ports, allowed: () => Promise.resolve(++checks === 1) });
  assert.equal(await runtime.apply(lab.action("web"), null, web, lab.plan), "refused"); assert.equal(lab.calls.length, 0); assert.equal(lab.counts().environmentReads, 1); assert.equal(checks, 2);
});
