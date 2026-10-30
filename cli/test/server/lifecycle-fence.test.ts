import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Result } from "../../src/lib/result.ts";
import { beginRegistration, beginLifecycleRegistration, beginLifecycleWork, settleLifecycleWork, lifecycleActionId, requestLifecycleRemoval, startLifecycleRemoval, completeLifecycleRemoval, startLifecyclePurge, completeLifecyclePurge, parseLifecycleFence } from "../../src/server/deployment/lifecycle-fence.ts";

const generation = "11111111-1111-4111-8111-111111111111";
const must = <T>(result: Result<T, string>) => { if (!result.ok) throw new Error(result.error); return result.value; };
const registration = () => must(beginRegistration("sample-app", generation));
const registered = () => { const s = registration(); return must(settleLifecycleWork(s, lifecycleActionId(s, 1))); };

test("registration and work are fenced until the matching action is reconciled", () => {
  const initial = registration();
  assert.equal(beginLifecycleWork(initial, "deploy").ok, false);
  assert.equal(settleLifecycleWork(initial, `${generation}:2`).ok, false);
  const ready = registered();
  const deploying = must(beginLifecycleWork(ready, "deploy"));
  assert.equal(beginLifecycleWork(deploying, "restore").ok, false);
  assert.equal(settleLifecycleWork(deploying, `${generation}:1`).ok, false);
  const settled = must(settleLifecycleWork(deploying, `${generation}:2`));
  const restore = must(beginLifecycleWork(settled, "restore"));
  assert.equal(lifecycleActionId(restore, 3), `${generation}:3`);
});

test("removal immediately fences new work while preserving prior uncertain intent", () => {
  const deploying = must(beginLifecycleWork(registered(), "deploy"));
  const fenced = must(requestLifecycleRemoval(deploying));
  assert.equal(fenced.lifecycle.phase, "removal-requested");
  assert.equal(beginLifecycleWork(fenced, "deploy").ok, false);
  assert.equal(startLifecycleRemoval(fenced, ["sample-db"]).ok, false);
  assert.equal(startLifecyclePurge(fenced, `${generation}:3`).ok, false);
  assert.equal(settleLifecycleWork(fenced, `${generation}:3`).ok, false);
  const quiescent = must(settleLifecycleWork(fenced, `${generation}:2`));
  const removing = must(startLifecycleRemoval(quiescent, ["sample-db"]));
  assert.equal(completeLifecycleRemoval(removing, `${generation}:2`).ok, false);
  const removed = must(completeLifecycleRemoval(removing, `${generation}:3`));
  if (removed.lifecycle.phase !== "removed") throw new Error("expected tombstone");
  assert.deepEqual(removed.lifecycle.tombstone, { removal: 3, volumes: ["sample-db"] });
  assert.equal(beginLifecycleWork(removed, "deploy").ok, false);
  assert.equal(startLifecyclePurge(removed, `${generation}:2`).ok, false);
  const purging = must(startLifecyclePurge(removed, `${generation}:3`));
  assert.equal(completeLifecyclePurge(purging, `${generation}:3`).ok, false);
  const purged = must(completeLifecyclePurge(purging, `${generation}:4`));
  assert.equal(purged.lifecycle.phase, "purged");
  assert.equal(startLifecyclePurge(purged, `${generation}:3`).ok, false);
  assert.equal(beginLifecycleWork(purged, "restore").ok, false);
});

test("removal can fence a still-unresolved registration", () => {
  const requested = must(requestLifecycleRemoval(registration()));
  assert.equal(startLifecycleRemoval(requested, []).ok, false);
  const settled = must(settleLifecycleWork(requested, `${generation}:1`));
  assert.equal(startLifecycleRemoval(settled, []).ok, true);
});

test("persisted state is strict, bounded, immutable and rejects contradictory identities", () => {
  assert.equal(beginRegistration("../other", generation).ok, false);
  assert.equal(beginRegistration("sample", "invalid").ok, false);
  const quiescent = must(requestLifecycleRemoval(registered()));
  assert.equal(startLifecycleRemoval(quiescent, ["sample-db", "sample-db"]).ok, false);
  assert.equal(startLifecycleRemoval(quiescent, ["../db"]).ok, false);
  const fenced = must(requestLifecycleRemoval(must(beginLifecycleWork(registered(), "deploy"))));
  const restored = must(parseLifecycleFence(JSON.parse(JSON.stringify(fenced))));
  assert.deepEqual(restored, fenced);
  assert.equal(Reflect.set(restored, "nextAction", 1), false);
  if (restored.lifecycle.phase !== "removal-requested") throw new Error("expected pending removal");
  const removing = must(startLifecycleRemoval(must(settleLifecycleWork(restored, `${generation}:2`)), ["sample-db"]));
  if (removing.lifecycle.phase !== "removing") throw new Error("expected removal");
  assert.equal(Reflect.set(removing.lifecycle.volumes, 0, "other"), false);
  assert.equal(parseLifecycleFence({ ...restored, extra: "secret" }).ok, false);
  assert.equal(parseLifecycleFence({ ...restored, nextAction: 3 }).ok, false);
  assert.equal(parseLifecycleFence({ ...restored, lifecycle: { ...restored.lifecycle, removal: 2 } }).ok, false);
  assert.equal(parseLifecycleFence({ ...restored, lifecycle: { ...restored.lifecycle, active: { kind: "purge", sequence: 2 } } }).ok, false);
  assert.equal(parseLifecycleFence({ ...restored, lifecycle: { phase: "removed" } }).ok, false);
});

test("action sequence exhaustion refuses new intents", () => {
  const input = { ...registered(), nextAction: Number.MAX_SAFE_INTEGER };
  assert.equal(parseLifecycleFence(input).ok, true);
  assert.equal(beginLifecycleWork(input, "deploy").ok, false);
  assert.equal(requestLifecycleRemoval(input).ok, false);
});

test("registration updates participate in the same per-app fence", () => {
  const updating = must(beginLifecycleRegistration(registered()));
  assert.equal(beginLifecycleRegistration(updating).ok, false);
  assert.equal(beginLifecycleWork(updating, "deploy").ok, false);
  const removed = must(requestLifecycleRemoval(updating));
  assert.equal(startLifecycleRemoval(removed, []).ok, false);
  const settled = must(settleLifecycleWork(removed, `${generation}:2`));
  assert.equal(startLifecycleRemoval(settled, []).ok, true);
  assert.equal(beginRegistration("app-", generation).ok, true);
});
