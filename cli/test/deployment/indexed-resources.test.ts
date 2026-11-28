import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { HttpPlanPort } from "../../src/contracts/http-plan.ts";
import { parseApplicationPlan } from "../../src/contracts/application-plan.ts";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { fixture, template, commit, generation } from "./http-test-fixture.ts";

// Admission is exercised through lifecycle intent, never by direct reservation or release calls.
test("serialized app admission counts outstanding overlap after restart and expiry", async (t) => {
  const { path, index, ports, builds } = await fixture(t);
  await index.prepareApp("other");
  const registered = await index.reserveRegistration("other", generation, "swarm");
  await index.submitRegistration("other", registered, generation); await index.reconcileRegistration("other", registered, generation);
  for (const app of ["shop", "other"]) await index.prepareBuild(app, commit, builds);
  const large: HttpPlanPort = { preview: async (...args) => {
    const original = await ports.preview(...args);
    const service = original.services["web"]; assert.ok(service !== undefined);
    return { ...original, grants: { ...original.grants, cpu_millicores: 1000 },
      services: { web: { ...service, resources: { ...service.resources, nanoCpus: 1_000_000_000 } } } };
  } };
  const requests = await Promise.all([index.prepareHttpRollout("shop", randomUUID(), commit, { ...ports, ...large }), index.prepareHttpRollout("other", randomUUID(), commit, { ...ports, ...large })]);
  const results = await Promise.allSettled(requests.map((request, position) => index.admitHttpRollout(position === 0 ? "shop" : "other", request.ticket, ports)));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const snapshot = await index.resourceSnapshot();
  assert.equal(snapshot?.charges.length, 1);
  const charge = snapshot.charges[0]; assert.ok(charge !== undefined);
  assert.equal(charge.target.budget.cpu, 1000);
  const rejected = charge.app === "shop" ? "other" : "shop";
  const request = requests[rejected === "shop" ? 0 : 1];
  await index.close();
  const recovered = await openLifecycleAppIndex(path); t.after(() => recovered.close());
  await assert.rejects(recovered.admitHttpRollout(rejected, request.ticket, { ...ports, now: () => 999_999 }), /deadline expired/);
  assert.deepEqual(await recovered.resourceSnapshot(), snapshot);
});

test("stored plans reject changed ownership, resources, effects and secret payloads", () => {
  assert.ok(parseApplicationPlan(template).ok);
  const service = template.services["web"]; assert.ok(service !== undefined);
  for (const value of [{ ...template, app: "other" }, { ...template, unexpected: true },
    { ...template, services: { web: { ...service, image: "localhost:5000/shop/../other@sha256:" + "d".repeat(64) } } },
    { ...template, services: { web: { ...service, environment: { TOKEN: { kind: "secret", key: "TOKEN", value: "must-not-be-retained" } } } } },
    { ...template, services: { web: { ...service, resources: { ...service.resources, memoryBytes: 0 } } } },
    { ...template, policy: { ...template.policy, updateTimeoutSeconds: 0 } },
  ]) assert.equal(parseApplicationPlan(value).ok, false);
});
