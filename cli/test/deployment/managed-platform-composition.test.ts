/* eslint-disable functional/immutable-data, functional/prefer-immutable-types -- owns fixture boundary observations */
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { managedIndexFixture } from "./managed-index-fixture.ts";
import { managedPlatform } from "../../src/server/composition/managed-platform.ts";
import { managedSourceContext } from "../../src/server/deployment/managed-source-context.ts";
import { startRegistrationControl } from "../../src/server/composition/registration.ts";

test("platform composition creates no transport, runtime, journal or private-input effects and checks scope before preparation", async (t) => {
  const lab = await managedIndexFixture(t); const api: string[] = []; const builds: string[] = [];
  const owner = managedPlatform(lab.index(), { publicRegistrations: lab.path + "/missing-public", privateRegistrations: lab.path + "/missing-private", swarmAuthority: lab.path + "/missing-host", migrationPolicy: lab.path + "/missing-policy", domain: "lab.test" }, {
    api: { request: (method) => { api.push(method); return Promise.reject(new Error("unexpected native access")); } },
    builds: { ...lab.artifacts, now: lab.runtime.now, prepare: () => { builds.push("prepare"); return Promise.reject(new Error("unexpected build")); }, images: () => [] }, canAccess: () => Promise.resolve(false),
  });
  const context = managedSourceContext(lab.source); const runtime = await owner.work.forRun(context); await owner.health(context);
  assert.deepEqual(api, []); assert.deepEqual(builds, []); assert.equal(await runtime.requestAllowed(lab.source), false);
  await assert.rejects(owner.prepare("shop", randomUUID(), "a".repeat(40)), /outside managed/); assert.deepEqual(api, []); assert.deepEqual(builds, []); assert.deepEqual(await lab.index().pendingManagedDeployments(), []);
});

test("managed removal requires the current owned platform registration before it can fence the app", async (t) => {
  const lab = await managedIndexFixture(t);
  const api: string[] = [];
  const owner = managedPlatform(lab.index(), { publicRegistrations: "missing", privateRegistrations: "missing",
    swarmAuthority: "missing", migrationPolicy: "missing", domain: "lab.test" }, {
    api: { request: (method) => { api.push(method); return Promise.reject(new Error("unexpected Docker request")); } },
    builds: { ...lab.artifacts, now: lab.runtime.now, prepare: () => Promise.reject(new Error("unexpected build")), images: () => [] },
    canAccess: () => Promise.resolve(true), actor: { kind: "operator-control", identity: "fixture-operator" },
  });
  await assert.rejects(owner.removal.step("shop"), /authority unavailable/);
  assert.deepEqual(api, []);
  assert.deepEqual(await lab.index().verifiedRegistration("shop"), lab.plan.infrastructure.registration);
});

test("empty managed health snapshots do not inspect Docker or borrow unregistered application contexts", async (t) => {
  const lab = await managedIndexFixture(t); const unreachable = () => Promise.reject(new Error("unexpected external effect"));
  const owner = managedPlatform(lab.index(), { publicRegistrations: "missing", privateRegistrations: "missing", swarmAuthority: "missing", migrationPolicy: "missing", domain: "lab.test" }, {
    api: { request: unreachable }, builds: { ...lab.artifacts, now: lab.runtime.now, prepare: unreachable, images: () => [] }, canAccess: () => Promise.resolve(true),
  });
  assert.deepEqual(await lab.index().managedHealthContexts(lab.runtime), []); const snapshot = await owner.healthSnapshot();
  assert.deepEqual(await snapshot.services.observe({ app: "other", incarnation: randomUUID(), dataOwner: randomUUID(), service: "worker" }), { status: "unavailable" });
});

test("managed health composes Docker's 404 service absence response through read-only native ports", async (t) => {
  const lab = await managedIndexFixture(t); const context = managedSourceContext(lab.source); const methods: string[] = [];
  const owner = managedPlatform({ ...lab.index(), managedHealthContexts: () => Promise.resolve([context]) }, { publicRegistrations: "missing", privateRegistrations: "missing", swarmAuthority: "missing", migrationPolicy: "missing", domain: "lab.test" }, {
    api: { request: (method) => { methods.push(method); return Promise.resolve({ status: 404, value: null }); } }, builds: { ...lab.artifacts, now: lab.runtime.now, prepare: () => Promise.reject(new Error("unexpected build")), images: () => [] }, canAccess: () => Promise.resolve(true),
  });
  const health = await owner.healthSnapshot(); assert.deepEqual(methods, []);
  assert.deepEqual(await health.services.observe({ app: lab.ownership.app, incarnation: lab.ownership.incarnation, dataOwner: lab.ownership.dataOwner, service: "worker" }), { status: "absent" }); assert.deepEqual(methods, ["GET"]);
});

test("the configured deployer starts and closes managed recovery without enabling mutations or requiring a Docker daemon for empty work", async (t) => {
  const path = await mkdtemp(join(tmpdir(), "kayra-managed-bootstrap-")); await mkdir(join(path, "managed-apps")); await mkdir(join(path, "lifecycle"));
  const control = await startRegistrationControl({ platformDirectory: path, registrationObservations: join(path, "observations"), publicRegistrations: join(path, "public"), privateRegistrations: join(path, "private"), swarmAuthority: join(path, "host.json"), migrationPolicy: join(path, "policy.json"), domain: "lab.test" });
  t.after(async () => { await control.close(); await rm(path, { recursive: true, force: true }); });
  assert.deepEqual(await control.health(), []); assert.deepEqual(await control.handle("/registration/initialize", {}), { status: "ready" }); assert.deepEqual(await control.health(), []);
  assert.equal(await control.handle("/deployment/remove-step", { app: "shop" }), undefined);
  await assert.rejects(control.handle("/deployment/prepare", { app: "shop", request: randomUUID(), commit: "a".repeat(40) }), /unavailable or outside scope/);
});
