/* eslint-disable functional/prefer-immutable-types -- records trusted boundary calls in the fixture */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { managedPlans } from "../../src/server/composition/managed-plans.ts";
import type { ImageDeclaration } from "../../src/contracts/image-admission.ts";

test("managed compilation resolves declared service and one-shot image contexts before emitting immutable plans", async () => {
  const input = await managedPlanFixture(); const calls: (readonly ImageDeclaration[])[] = [];
  const plans = managedPlans({ read: () => Promise.resolve(input), images: { resolveDeclared: (app, declarations) => {
    assert.equal(app, "shop");
    // eslint-disable-next-line functional/immutable-data -- retain the independent registry inspection contexts
    calls.push([...declarations]); return Promise.resolve({ status: "accepted", images: input.scope.images });
  } } });
  const args = [input.scope.registration, input.artifact.sha, input.artifact.artifact] as const;
  assert.deepEqual(await plans.volumeKeys(...args), ["database"]); assert.equal(calls.length, 0);
  assert.deepEqual(await plans.preview(...args, input.scope.volumes), input.plan); assert.equal(calls.length, 1);
  assert.ok(calls[0]?.some((item) => item.kind === "one-shot" && item.volumeTargets.length === 0)); assert.ok(calls[0]?.some((item) => item.volumeTargets.includes("/var/lib/database")));
});

test("input identity substitution is refused before reserving logical keys or inspecting images", async () => {
  const input = await managedPlanFixture(); const unreachable = () => Promise.reject(new Error("unexpected registry access"));
  const plans = managedPlans({ read: () => Promise.resolve(input), images: { resolveDeclared: unreachable } });
  await assert.rejects(plans.volumeKeys(input.scope.registration, "f".repeat(40), input.artifact.artifact), /identity/);
  await assert.rejects(plans.volumeKeys({ ...input.scope.registration, registrationGeneration: randomUUID() }, input.artifact.sha, input.artifact.artifact), /identity/);
  await assert.rejects(plans.preview(input.scope.registration, input.artifact.sha, "f".repeat(64), input.scope.volumes), /identity/);
});

test("unavailable or unsupported registry metadata and missing volume authority never compile a plan", async () => {
  const input = await managedPlanFixture(); const args = [input.scope.registration, input.artifact.sha, input.artifact.artifact] as const;
  for (const status of ["unsupported", "unavailable"] as const) {
    const plans = managedPlans({ read: () => Promise.resolve(input), images: { resolveDeclared: () => Promise.resolve({ status }) } });
    await assert.rejects(plans.preview(...args, input.scope.volumes), /image metadata/);
  }
  const plans = managedPlans({ read: () => Promise.resolve(input), images: { resolveDeclared: () => Promise.resolve({ status: "accepted", images: input.scope.images }) } });
  await assert.rejects(plans.preview(...args, []), /volume allocations/);
});
