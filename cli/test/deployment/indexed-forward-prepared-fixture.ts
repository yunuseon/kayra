/* eslint-disable functional/no-let, functional/prefer-immutable-types -- owns indexed forward preparation and trusted operator authority */
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { indexedForwardFixture } from "./indexed-forward-fixture.ts";
import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { parseLifecycleEnvelope } from "../../src/server/deployment/lifecycle-envelope.ts";

export const preparedForwardFixture = async (t: TestContext) => {
  const lab = await indexedForwardFixture(t); const selected = await lab.index().selectManagedForward("shop", lab.request, lab.actor, lab.ports);
  const images = () => lab.plan.images.map((image) => image.pull);
  const built = await lab.index().prepareManagedForwardBuild("shop", lab.request, { ...lab.artifacts, now: lab.runtime.now, images, authorizeSelection: lab.ports.authorize, prepare: (_registration, commit) => Promise.resolve(JSON.stringify({ commit })) });
  const candidate = parseManagedApplicationPlan({ ...lab.source.candidate, commit: built.build.commit, artifact: built.build.artifact }); assert.ok(candidate.ok);
  let allowed = true; let authorizations = 0; const operator = { actor: { ...lab.actor, identity: "fixture-continuation-operator" }, reason: "Continue recovery using this reviewed build after preserving the held data" };
  const ports = { ...lab.ports, images, compare: () => Promise.resolve("unchanged" as const), authorizeReservation: (decision: { readonly id: string }, _candidate: unknown, current: typeof operator) => { authorizations++; assert.equal(decision.id, selected.id); assert.deepEqual(current, operator); return Promise.resolve(allowed); } };
  const envelope = join(lab.selectionDirectory, "..", "..", "..", "state.json");
  return { ...lab, selected, built, operator, candidate: candidate.value, ports, envelope, denyReservation: () => { allowed = false; }, authorizations: () => authorizations, readEnvelope: async () => { const parsed = parseLifecycleEnvelope(JSON.parse(await readFile(envelope, "utf8"))); assert.ok(parsed.ok); return parsed.value; } };
};
