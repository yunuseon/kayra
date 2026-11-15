/* eslint-disable functional/no-let -- native and enablement fixtures hold mutable observations */
/* eslint-disable functional/prefer-immutable-types -- TestContext is an externally owned handle */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { AppOverlayGrant, AppOverlayPort } from "../../src/contracts/app-overlay.ts";
import { parseSwarmAuthority } from "../../src/contracts/swarm-authority.ts";
import { platformOverlayControl } from "../../src/server/composition/platform-overlays.ts";
import { createLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";

const fixture = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "kayra-platform-overlay-"));
  const indexPath = join(root, "index");
  const index = await createLifecycleAppIndex(indexPath);
  const generation = randomUUID(); await index.prepareApp("shop"); const ticket = await index.reserveRegistration("shop", generation, "swarm");
  const raw: unknown = JSON.parse(await readFile(new URL("../../../ci/tests/swarm-host/authority.json", import.meta.url), "utf8")); const host = parseSwarmAuthority(raw); assert.ok(host.ok);
  let actual: AppOverlayGrant | null = null; let creates = 0; let enabled = true; let authorized = true;
  const native: AppOverlayPort = { observe: () => Promise.resolve(actual === null ? { status: "absent" } : { status: "owned", grant: actual }), create: (action) => { creates += 1; actual = { scope: action.scope, id: "x".repeat(25) }; return Promise.resolve("acknowledged"); } };
  const open = () => platformOverlayControl({ directory: join(root, "platform-state"), native,
    ownership: (app, value, selected) => index.registrationOwnership(app, selected, value),
    host: () => Promise.resolve(enabled ? host.value : undefined), authorize: () => Promise.resolve(authorized),
  });
  const control = open();
  t.after(async () => { await control.close(); await index.close(); await rm(root, { recursive: true, force: true }); });
  return { root, index, control, open, input: { app: "shop", generation, ticket }, creates: () => creates, missing: () => { actual = null; }, disable: () => { enabled = false; }, deny: () => { authorized = false; } };
};

test("platform overlay control requires an admitted exact registration before any infrastructure effect", async (t) => {
  const f = await fixture(t); await assert.rejects(f.control.provision(f.input), /admitted Swarm/); assert.equal(f.creates(), 0);
  await f.index.submitRegistration("shop", f.input.ticket, f.input.generation);
  await assert.rejects(f.control.provision({ ...f.input, generation: randomUUID() }), /admitted Swarm/); assert.equal(f.creates(), 0);
  assert.equal(await f.control.provision({ ...f.input, network: "app-selected" }), undefined);
  const [left, right] = await Promise.all([f.control.provision(f.input), f.control.provision(f.input)]);
  assert.deepEqual(left, right); assert.equal(f.creates(), 1);
  await f.control.close(); const reopened = f.open();
  try { assert.deepEqual(await reopened.provision(f.input), left); f.missing(); await assert.rejects(reopened.provision(f.input), /unavailable/); assert.equal(f.creates(), 1); }
  finally { await reopened.close(); }
});

test("operator enablement and lifecycle authorization remain required for the platform effect", async (t) => {
  const f = await fixture(t); await f.index.submitRegistration("shop", f.input.ticket, f.input.generation); f.disable();
  await assert.rejects(f.control.provision(f.input), /not enabled/); assert.equal(f.creates(), 0);
});

test("a revoked lifecycle authorization prevents creation after durable intent", async (t) => {
  const f = await fixture(t); await f.index.submitRegistration("shop", f.input.ticket, f.input.generation); f.deny();
  await assert.rejects(f.control.provision(f.input), /refused/); assert.equal(f.creates(), 0);
});
