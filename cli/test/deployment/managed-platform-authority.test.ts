/* eslint-disable functional/no-let -- models platform publications changing independently of accepted deployment state */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { parseManagedExecutionContext } from "../../src/contracts/managed-execution-context.ts";
import { managedRuntimeAuthority } from "../../src/server/platform/managed-runtime-authority.ts";
import type { App } from "../../src/contracts/app-registration.ts";
import { typed } from "../../src/lib/typed.ts";

const fixture = async () => {
  const lab = await managedPlanFixture(); const plan = lab.plan; const parsed = parseManagedExecutionContext({ version: 1, protocol: "managed-v3", runtime: "swarm", owner: plan.infrastructure.ownership, run: randomUUID(), action: plan.infrastructure.ownership.incarnation + ":2", source: "e".repeat(64), application: plan, previous: null, allocationRequired: true, createdAt: 1000, admissionDeadline: 91000, deadline: 901000 }); assert.ok(parsed.ok); const context = parsed.value;
  const app = lab.scope.app; const initial = { registration: plan.infrastructure.registration, app, host: plan.host, infrastructure: plan.infrastructure, configurationIdentity: plan.configurationIdentity, migrationPolicy: { version: 1, migrationTimeoutCeilingSeconds: plan.policy.migrationTimeoutCeilingSeconds } } as const;
  let current: typeof initial | undefined = initial; let owned = true; let reads = 0;
  const authority = managedRuntimeAuthority({ owned: () => Promise.resolve(owned), current: () => { reads++; return Promise.resolve(current); } });
  const web = plan.services["web"]; assert.ok(web); const action = { app: context.owner.app, incarnation: context.owner.incarnation, dataOwner: context.owner.dataOwner, service: "web", action: context.action, effect: "scrub" as const, plan: "a".repeat(64), deadline: 91000 };
  return { context, plan, app, initial, authority, action, reads: () => reads, denyOwnership: () => { owned = false; }, change: (value: typeof initial | undefined) => { current = value; } };
};

test("current platform publications authorize the accepted plan without granting private journal or runtime effects", async () => {
  const lab = await fixture(); assert.equal(await lab.authority.allowed(lab.context, { kind: "admission" }), true); assert.equal(await lab.authority.allowed(lab.context, { kind: "allocation" }), true);
  const web = lab.plan.services["web"]; assert.ok(web); assert.equal(await lab.authority.allowed(lab.context, { kind: "service-inputs", application: lab.plan, service: web }), true);
});

test("a changed registration, host, infrastructure, input identity, budget or policy cannot borrow the old plan grant", async () => {
  const lab = await fixture(); const grants = lab.app.runtime === "swarm" ? lab.app.grants : undefined; assert.ok(grants);
  const variants = [
    { ...lab.initial, registration: { ...lab.initial.registration, registrationGeneration: randomUUID() } },
    { ...lab.initial, host: { ...lab.initial.host, node: "z".repeat(25) } },
    { ...lab.initial, infrastructure: { ...lab.initial.infrastructure, overlay: { ...lab.initial.infrastructure.overlay, id: "z".repeat(25) } } },
    { ...lab.initial, configurationIdentity: "sha256:" + "f".repeat(64) },
    { ...lab.initial, app: typed<App>({ ...lab.app, runtime: "swarm", grants: { ...grants, memory_bytes: 1 } }) },
    { ...lab.initial, migrationPolicy: { version: 1 as const, migrationTimeoutCeilingSeconds: 1 } },
    { ...lab.initial, app: { ...lab.app, secrets: [] } },
    { ...lab.initial, app: { ...lab.app, hosts: [] } },
  ];
  for (const variant of variants) { lab.change(variant); assert.equal(await lab.authority.allowed(lab.context, { kind: "admission" }), false); }
});

test("owned cleanup and audit remain available without current start grants but never without immutable ownership", async () => {
  const lab = await fixture(); lab.change(undefined); assert.equal(await lab.authority.allowed(lab.context, { kind: "admission" }), false);
  assert.equal(await lab.authority.allowed(lab.context, { kind: "service", purpose: "deployment", action: lab.action }), false);
  const before = lab.reads(); assert.equal(await lab.authority.allowed(lab.context, { kind: "service", purpose: "cleanup", action: lab.action }), true); assert.equal(await lab.authority.allowed(lab.context, { kind: "migration", effect: "fence" }), true); assert.equal(await lab.authority.allowed(lab.context, { kind: "recovery" }), true); assert.equal(lab.reads(), before);
  assert.equal(await lab.authority.allowed(lab.context, { kind: "service", purpose: "cleanup", action: { ...lab.action, dataOwner: randomUUID() } }), false);
  lab.denyOwnership(); assert.equal(await lab.authority.allowed(lab.context, { kind: "service", purpose: "cleanup", action: lab.action }), false); assert.equal(await lab.authority.allowed(lab.context, { kind: "accepted-recovery" }), false);
});

test("maintenance requires its current operator grant and service input access cannot borrow a revoked secret", async () => {
  const lab = await fixture(); const changed = parseManagedExecutionContext({ ...lab.context, application: { ...lab.plan, grants: { ...lab.plan.grants, maintenance: true }, rollout: { ...lab.plan.rollout, strategy: "maintenance", mixed_version_compatible: false } } }); assert.ok(changed.ok);
  assert.equal(await lab.authority.allowed(changed.value, { kind: "admission" }), false);
  assert.equal(await lab.authority.allowed(changed.value, { kind: "service", purpose: "deployment", action: { ...lab.action, effect: "remove" } }), false);
  assert.equal(await lab.authority.allowed(changed.value, { kind: "service", purpose: "cleanup", action: { ...lab.action, effect: "remove" } }), true);
  const web = lab.plan.services["web"]; assert.ok(web); assert.equal(await lab.authority.allowed(lab.context, { kind: "service-inputs", application: lab.plan, service: { ...web, inputs: { ...web.inputs, environment: { OTHER: { kind: "secret", key: "UNGRANTED" } } } } }), false);
});
