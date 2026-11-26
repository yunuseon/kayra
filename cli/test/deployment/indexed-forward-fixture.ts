/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/immutable-data -- owns fixture observations, clocks, journal faults and an optional delayed lock acquisition */
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { managedIndexRuntimeFixture } from "./managed-index-runtime-fixture.ts";
import type { ManagedServiceAction } from "../../src/contracts/managed-swarm-service.ts";
import type { ServiceVersion } from "../../src/contracts/swarm-service.ts";
import { parseManagedRelease, managedReleaseBaselines } from "../../src/server/deployment/managed-release.ts";
import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { parseManagedLifecycleSource } from "../../src/server/deployment/managed-lifecycle-source.ts";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { parseLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index-state.ts";

export const indexedForwardFixture = async (t: TestContext) => {
  let cut: "catalog-before" | "catalog-after" | "decision-after" | "publication-before" | "publication-after" | "build-publication-before" | "build-publication-after" | "reservation-before" | "reservation-after" | "cleanup-child-before" | "cleanup-child-after" | "cleanup-publication-before" | "cleanup-publication-after" | "handoff-publication-after" | "transfer-write-before" | "transfer-write-after" | undefined; let decisions = 0;
  let rootGate: { readonly entered: ReturnType<typeof Promise.withResolvers<undefined>>; readonly release: ReturnType<typeof Promise.withResolvers<undefined>> } | undefined;
  const journals = async (...args: Parameters<typeof openJournal>) => {
    if (args[0].endsWith("/managed") && rootGate !== undefined) { const gate = rootGate; rootGate = undefined; gate.entered.resolve(undefined); await gate.release.promise; }
    const base = await openJournal(...args); return { ...base, write: async (value: Parameters<typeof base.write>[0]) => {
      const index = typeof value === "object" && value !== null && "apps" in value ? parseLifecycleAppIndex(value) : undefined;
      const selected = index?.apps.find((item) => item.app === "shop")?.forwardSelections?.[0];
      const transferring = index?.managedBindings?.some((binding) => binding.run === selected?.request) === true;
      const forward = typeof value === "object" && value !== null && "forward" in value ? value["forward"] : undefined;
      const phase = typeof forward === "object" && forward !== null && "phase" in forward ? forward["phase"] : undefined;
      const point = transferring ? "transfer-write" : args[0].endsWith("/effects") ? "cleanup-child" : phase === "transferring" ? "handoff-publication" :
        phase === "fencing" ? "cleanup-publication" : forward !== undefined ? "reservation" : selected?.preparedBuild !== undefined ?
        "build-publication" : selected?.phase === "initializing" ? "catalog" : selected?.phase === "ready" ? "publication" :
        args[0].includes("/managed/forward/") ? "decision" : undefined;
      if (point !== undefined && cut === point + "-before") { cut = undefined; throw new Error("injected before " + point); }
      await base.write(value); if (point === "decision") decisions++;
      if (point !== undefined && cut === point + "-after") { cut = undefined; throw new Error("injected after " + point); }
    } };
  };
  const lab = await managedIndexRuntimeFixture(t, false, journals);
  const runtime = { ...lab.runtime, services: { ...lab.runtime.services, tombstone: (action: ManagedServiceAction, expected: ServiceVersion | null) => {
    const before = lab.services.get(action.service); assert.ok(before); assert.equal(before.status, "owned"); assert.ok(expected); assert.equal(expected.id, before.id); assert.equal(expected.version, before.version);
    lab.services.set(action.service, { ...before, version: before.version + 1, action: action.action, effect: action.effect, taskEffect: "remove", plan: action.plan, tombstone: true, retainedInputsCleared: action.effect === "scrub", containersStopped: true, containersConverged: true, replicas: 0, endpoint: "dnsrr", update: "completed", tasks: [] }); return Promise.resolve("acknowledged" as const);
  } } };
  await lab.index().requestManagedDeployment("shop", lab.source, runtime);
  for (let i = 0; i < 100; i++) { const value = await lab.index().tickManagedDeployment("shop", lab.source.run, runtime); assert.notEqual(value?.operation.phase, "held"); if (value?.operation.phase === "complete") break; }
  const initial = await lab.index().managedState("shop", runtime); assert.ok(initial?.active); const previous = parseManagedRelease(JSON.parse(await lab.artifacts.read(initial.active.record)));
  const build = await lab.index().prepareBuild("shop", "b".repeat(40), { ...lab.artifacts, now: runtime.now, prepare: () => Promise.resolve(JSON.stringify({ commit: "b".repeat(40) })), images: () => lab.plan.images.map((image) => image.pull) });
  const candidate = parseManagedApplicationPlan({ ...lab.plan, commit: build.commit, artifact: build.artifact, grants: { ...lab.plan.grants, maintenance: true }, rollout: { ...lab.plan.rollout, strategy: "maintenance", rollback_compatible: false } }); assert.ok(candidate.ok);
  const retained = managedReleaseBaselines(previous).filter((item) => previous.source.application.services[item.name]?.role === "retained-dependency").map((item) => ({ ...item, kind: "active" as const }));
  const source = parseManagedLifecycleSource({ ...lab.source, candidate: candidate.value, previous, retained, run: randomUUID(), action: lab.incarnation + ":3" }); await lab.index().requestManagedDeployment("shop", source, runtime);
  for (let i = 0; i < 100; i++) { const state = await lab.index().tickManagedDeployment("shop", source.run, runtime); assert.notEqual(state?.operation.phase, "held"); if (state?.operation.phase === "verifying") break; }
  const ready = await lab.index().managedState("shop", runtime); assert.equal(ready?.operation.phase, "verifying"); await lab.index().cancelManagedDeployment("shop", source.run, runtime); const held = await lab.index().tickManagedDeployment("shop", source.run, runtime); assert.equal(held?.operation.phase, "held"); assert.ok(held.operation.compatibilityFencedAt);
  const request = { app: "shop", blockedRun: source.run, request: randomUUID(), commit: "e".repeat(40), reason: "Prepare an explicit forward fix after the maintenance failure" }; const actor = { kind: "operator-control", identity: "fixture-operator" } as const;
  let allowed = true; const ports = { ...lab.artifacts, now: lab.runtime.now, authorize: () => Promise.resolve(allowed) };
  return { ...lab, runtime, source, held, request, actor, ports, cut: (point: typeof cut) => { cut = point; }, decisions: () => decisions, pauseRootOpen: () => { const gate = { entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>() }; rootGate = gate; return { entered: gate.entered.promise, release: () => { gate.release.resolve(undefined); } }; }, allow: () => { allowed = true; }, deny: () => { allowed = false; }, selectionDirectory: join(lab.directory, createHash("sha256").update("shop").digest("hex"), "managed", "forward", request.request) };
};

