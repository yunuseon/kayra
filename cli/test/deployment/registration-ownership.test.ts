import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { parseRegistrationOwnership } from "../../src/contracts/registration-ownership.ts";
import { createLifecycleAppIndex, openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { registrationControl } from "../../src/server/deployment/registration-control.ts";

// eslint-disable-next-line functional/prefer-immutable-types -- node:test owns the mutable journal cleanup context
const fixture = async (t: TestContext) => {
  const directory = await mkdtemp(join(tmpdir(), "kayra-registration-ownership-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, "index"); const index = await createLifecycleAppIndex(root, (metadata) => Promise.resolve({ ...metadata, status: "applied" }));
  t.after(() => index.close()); return { index, root };
};

test("bootstrap ownership is bound to the admitted registration and survives publication, retry and reopen", async (t) => {
  const { index, root } = await fixture(t); const app = "shop"; const incarnation = await index.prepareApp(app); const generation = randomUUID(); const ticket = await index.reserveRegistration(app, generation, "swarm");
  await assert.rejects(index.registrationOwnership(app, ticket, generation), /admitted Swarm intent/);
  await index.submitRegistration(app, ticket, generation); const reference = await index.registrationOwnership(app, ticket, generation);
  assert.equal(reference.runtime, "swarm"); assert.equal(reference.registration.registrationGeneration, generation); assert.equal(reference.registration.actionId, `${incarnation}:1`);
  assert.equal(reference.ownership.incarnation, incarnation); assert.notEqual(reference.ownership.dataOwner, incarnation); assert.ok(Object.isFrozen(reference)); assert.ok(Object.isFrozen(reference.ownership));
  const before = await readFile(join(root, "state.json"), "utf8"); assert.deepEqual(await index.registrationOwnership(app, ticket, generation), reference); assert.equal(await readFile(join(root, "state.json"), "utf8"), before);
  await index.reconcileRegistration(app, ticket, generation); assert.deepEqual(await index.dataOwnership(app), reference.ownership); assert.deepEqual(await index.registrationOwnership(app, ticket, generation), reference); await index.close();
  const reopened = await openLifecycleAppIndex(root); try { assert.deepEqual(await reopened.registrationOwnership(app, ticket, generation), reference); } finally { await reopened.close(); }
  const json = JSON.stringify(reference); for (const field of ["secrets", "environment", "volumes", "operations", "resources", "ticket"]) assert.equal(json.includes(`"${field}"`), false);
});

test("wrong ticket/generation and Compose registration cannot obtain a bootstrap data reference", async (t) => {
  const { index } = await fixture(t); const generation = randomUUID(); await index.prepareApp("shop"); const ticket = await index.reserveRegistration("shop", generation, "swarm"); await index.submitRegistration("shop", ticket, generation);
  await assert.rejects(index.registrationOwnership("shop", ticket, randomUUID()), /admitted Swarm/); await assert.rejects(index.registrationOwnership("shop", "foreign-ticket", generation), /admitted Swarm/);
  await index.prepareApp("legacy"); const legacyGeneration = randomUUID(); const legacyTicket = await index.reserveRegistration("legacy", legacyGeneration, "compose"); await index.submitRegistration("legacy", legacyTicket, legacyGeneration);
  await assert.rejects(index.registrationOwnership("legacy", legacyTicket, legacyGeneration), /admitted Swarm/);
});

test("ownership read contract rejects cross-app/incarnation and extra authority or secret fields", async (t) => {
  const { index } = await fixture(t); const generation = randomUUID(); await index.prepareApp("shop"); const ticket = await index.reserveRegistration("shop", generation, "swarm"); await index.submitRegistration("shop", ticket, generation); const reference = await index.registrationOwnership("shop", ticket, generation);
  for (const value of [{ ...reference, ownership: { ...reference.ownership, app: "other" } }, { ...reference, ownership: { ...reference.ownership, incarnation: randomUUID() } }, { ...reference, granted: true }, { ...reference, runtime: "compose" }, { ...reference, secrets: { KEY: "private" } }]) assert.equal(parseRegistrationOwnership(value).ok, false);
});

test("normal registration control scopes and validates the metadata read before reaching the index", async (t) => {
  const { index } = await fixture(t); const generation = randomUUID(); await index.prepareApp("shop"); const ticket = await index.reserveRegistration("shop", generation, "swarm"); await index.submitRegistration("shop", ticket, generation);
  const input = { app: "shop", generation, ticket }; const control = registrationControl({ index, canRegister: () => Promise.resolve(true) });
  assert.deepEqual(await control("/registration/ownership", input), await index.registrationOwnership("shop", ticket, generation));
  assert.equal(await control("/registration/ownership", { ...input, ownership: randomUUID() }), undefined);
  assert.equal(await control("/registration/ownership", { ...input, generation: "invalid" }), undefined);
  const denied = registrationControl({ index, canRegister: () => Promise.resolve(false) }); await assert.rejects(denied("/registration/ownership", input), /outside registration ownership scope/);
});
