import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { managedApplicationDigest, managedMigrationDescription, managedMigrationSeconds, parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { migrationSequenceDigest } from "../../src/contracts/migration-sequence.ts";
import type { ManagedServicePlan } from "../../src/contracts/managed-service-plan.ts";
import { managedMigrationInputs } from "../../src/server/deployment/managed-migration-inputs.ts";
import { sequenceFixture } from "./migration-sequence-fixture.ts";
import { prepareManagedTransition } from "../../src/server/deployment/managed-transition.ts";

test("managed migrations select each declared service's immutable image and private connectivity", async () => {
  const { plan } = await managedPlanFixture(); const run = randomUUID();
  const checked = parseManagedApplicationPlan({ ...plan, rollout: { ...plan.rollout, migrations: [...plan.rollout.migrations,
    { id: "seed", service: "worker", command: ["/seed"], timeout_seconds: 40, recovery: { kind: "status-probe", command: ["/seed-status"], timeout_seconds: 10 } },
  ] } }); assert.ok(checked.ok);
  const sequence = managedMigrationDescription(checked.value, run); assert.ok(sequence.ok);
  assert.equal(sequence.value.deployment, managedApplicationDigest(checked.value)); assert.equal(sequence.value.scope.run, run);
  assert.deepEqual(sequence.value.steps.map((step) => step.definition.id), ["schema", "seed"]);
  for (const step of sequence.value.steps) {
    const service: ManagedServicePlan | undefined = checked.value.services[step.definition.service]; assert.ok(service);
    assert.equal(step.template.image, service.image); assert.deepEqual(step.template.environment, service.inputs.environment);
    assert.deepEqual(step.template.networks, [plan.infrastructure.overlay.id]); assert.equal(JSON.stringify(step.template).includes(plan.host.network.id), false);
    assert.equal(Object.hasOwn(step.template, "mounts"), false); assert.equal(Object.hasOwn(step.template, "command"), false);
  }
  assert.equal(managedMigrationSeconds(checked.value), 90 + 30 + 240 + 90 + 40 + 240 + 90 + 10 + 30);
  const again = managedMigrationDescription(checked.value, run); assert.ok(again.ok); assert.equal(migrationSequenceDigest(again.value), migrationSequenceDigest(sequence.value));
});

test("migration validation rejects reserved operation inputs and unsupported commands before admission", async () => {
  const { plan } = await managedPlanFixture(); const web = plan.services["web"]; assert.ok(web);
  const injected = { ...plan, services: { ...plan.services, web: { ...web, inputs: { ...web.inputs, environment: { ...web.inputs.environment, KAYRA_OPERATION_ID: { kind: "literal", value: "forged" } } } } } };
  assert.equal(parseManagedApplicationPlan(injected).ok, false);
  const oversized = { ...plan, rollout: { ...plan.rollout, migrations: [{ ...plan.rollout.migrations[0], command: ["x".repeat(4097)] }] } };
  assert.equal(parseManagedApplicationPlan(oversized).ok, false);
  assert.equal(managedMigrationDescription(plan, "not-a-run").ok, false);
  assert.equal(managedMigrationDescription({ ...plan, rollout: { ...plan.rollout, migrations: [] } }, randomUUID()).ok, false);
  assert.equal(managedMigrationSeconds({ ...plan, rollout: { ...plan.rollout, migrations: [] } }), 0);
});

test("retained dependency generations do not redirect application migration inputs", async () => {
  const { plan } = await managedPlanFixture(); const db = plan.services["db"]; assert.ok(db);
  const generation = randomUUID();
  const candidate = parseManagedApplicationPlan({ ...plan, infrastructure: { ...plan.infrastructure, registration: { ...plan.infrastructure.registration, registrationGeneration: generation } },
    services: Object.fromEntries(Object.entries(plan.services).map(([name, service]) => [name, { ...service, inputs: { ...service.inputs, registration: { ...service.inputs.registration, registrationGeneration: generation } } }])),
  }); assert.ok(candidate.ok);
  const normalized = await prepareManagedTransition(plan, candidate.value, [], { compare: () => Promise.resolve("unchanged" as const) }, { deadline: Date.now() + 1000, now: Date.now }); assert.ok(normalized.ok);
  const sequence = managedMigrationDescription(normalized.value.plan, randomUUID()); assert.ok(sequence.ok);
  assert.deepEqual(sequence.value.steps[0]?.template.environment, normalized.value.plan.services["web"]?.inputs.environment);
  assert.equal(sequence.value.steps[0]?.template.image, normalized.value.plan.services["web"]?.image);
  assert.notDeepEqual(sequence.value.steps[0]?.template.environment, db.inputs.environment);
  assert.deepEqual(normalized.value.plan.services["db"]?.inputs.registration, db.inputs.registration);
});


test("managed migration descriptions recover a lost Start acknowledgement under the existing sequence owner", async (t) => {
  const { plan } = await managedPlanFixture();
  const description = managedMigrationDescription(plan, randomUUID()); assert.ok(description.ok);
  const lab = await sequenceFixture(t, description.value, {
    materialize: (job) => {
      const reference = managedMigrationInputs(plan, job); assert.ok(reference.ok);
      assert.deepEqual(reference.value, plan.services["web"]?.inputs);
      for (const forged of [{ ...job, command: ["/other"] }, { ...job, networks: [plan.host.network.id] },
        { ...job, scope: { ...job.scope, incarnation: randomUUID() } }, { ...job, environment: {} }]) assert.equal(managedMigrationInputs(plan, forged).ok, false);
      return Promise.resolve(Object.fromEntries(Object.entries(reference.value.environment).map(([key, binding]) => [key, binding.kind === "literal" ? binding.value : "secret-value"])));
    },
    afterStart: () => { throw new Error("lost managed Start acknowledgement"); },
  });
  const prepared = await lab.prepare(); await assert.rejects(lab.drive(), /lost managed Start acknowledgement/);
  const interrupted = await lab.owner().read(); const execution = interrupted?.steps[0]?.attempts[0]?.execution; assert.ok(execution);
  await lab.reopen(); const done = await lab.drive(); assert.equal(done.phase, "succeeded");
  assert.equal(done.deadline, prepared.deadline);
  assert.equal(done.steps[0]?.executionDeadline, execution.executionDeadline);
  assert.equal([...lab.nodes.values()].reduce((count, node) => count + node.executions(), 0), 1);
  assert.ok(done.steps[0].attempts[0]?.execution?.barrier);
  assert.equal(JSON.stringify(await lab.journal().read()).includes("secret-value"), false);
});
