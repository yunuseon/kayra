import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseSwarmAuthority } from "../../src/contracts/swarm-authority.ts";
import type { SwarmHostObservation } from "../../src/contracts/resource-authority.ts";
import { parseResourceBook, reserveResources, settleResources } from "../../src/server/deployment/resource-book.ts";

const host = parseSwarmAuthority(JSON.parse(readFileSync(new URL("../../../ci/tests/swarm-host/authority.json", import.meta.url), "utf8")));
assert.ok(host.ok);
const authority = host.value;
const ready: SwarmHostObservation = { status: "ready", engine: "29.9.3", api: "1.56", node: authority.node, cluster: authority.cluster, network: authority.network.id,
  capacity: { cpu: authority.profile.cpu_millicores, memory: authority.profile.memory_bytes }, standing: { cpu: authority.profile.platform_cpu_millicores, memory: authority.profile.platform_memory_bytes } };
const release = (plan: string, cpu = 100, memory = 64 * 1024**2) => ({ plan: plan.repeat(64), budget: { cpu, memory } });
const a = release("a");
const b = release("b");
const intent = { app: "shop", incarnation: "11111111-1111-4111-8111-111111111111", sequence: 2, previous: null, target: a, peak: a.budget, deadline: 91_000, result: "pending" };

test("peak envelopes replace active charges, deadlines retain charges and settlement is fenced", () => {
  const first = reserveResources(null, authority, ready, intent, 1000);
  assert.ok(first.ok);
  const active = settleResources(first.value, intent.app, intent.incarnation, 2, "target");
  assert.ok(active.ok);
  const candidate = { ...intent, sequence: 3, previous: a, target: b, peak: { cpu: 200, memory: 128 * 1024**2 } };
  const overlap = reserveResources(active.value, authority, ready, candidate, 1000);
  assert.ok(overlap.ok);
  assert.equal(overlap.value.charges.length, 1);
  assert.deepEqual(overlap.value.charges[0]?.peak, candidate.peak);
  assert.deepEqual(reserveResources(overlap.value, authority, { status: "unavailable" }, candidate, 999_999), overlap);
  assert.equal(settleResources(overlap.value, intent.app, intent.incarnation, 2, "absent").ok, false);
  assert.equal(reserveResources(overlap.value, authority, ready, { ...candidate, sequence: 4 }, 1000).ok, false);
  const rollback = settleResources(overlap.value, intent.app, intent.incarnation, 3, "previous");
  assert.ok(rollback.ok);
  assert.deepEqual(settleResources(rollback.value, intent.app, intent.incarnation, 3, "previous"), rollback);
  assert.equal(settleResources(rollback.value, intent.app, intent.incarnation, 3, "target").ok, false);
  assert.equal(reserveResources(rollback.value, authority, ready, intent, 1000).ok, false);
  const retry = reserveResources(rollback.value, authority, ready, { ...candidate, sequence: 4 }, 1000);
  assert.ok(retry.ok);
  assert.equal(retry.value.charges[0]?.previous?.plan, a.plan);
});

test("competing apps, invalid observations and overflow cannot over-admit or free expired capacity", () => {
  const huge = release("a", authority.profile.cpu_millicores - authority.profile.platform_cpu_millicores,
    authority.profile.memory_bytes - authority.profile.platform_memory_bytes);
  const full = reserveResources(null, authority, ready, { ...intent, target: huge, peak: huge.budget }, 1000);
  assert.ok(full.ok);
  const other = { ...intent, app: "other", incarnation: "33333333-3333-4333-8333-333333333333", deadline: 1_000_000 };
  assert.equal(reserveResources(full.value, authority, ready, other, 999_999).ok, false);
  for (const observation of [{ status: "unavailable" }, { ...ready, network: "x" }, { ...ready, capacity: { cpu: 99999, memory: 99999 } }] as const) assert.equal(reserveResources(null, authority, observation, intent, 1000).ok, false);
  for (const request of [{ ...intent, deadline: 1000 }, { ...intent, deadline: 91_001 }, { ...intent, peak: { cpu: 1, memory: 1 } }, { ...intent, peak: { cpu: Number.MAX_SAFE_INTEGER, memory: Number.MAX_SAFE_INTEGER } }]) assert.equal(reserveResources(null, authority, ready, request, 1000).ok, false);
  const snapshot = parseResourceBook(full.value);
  assert.ok(snapshot.ok && Object.isFrozen(snapshot.value.charges[0]?.target.budget));
  assert.equal(parseResourceBook({ ...full.value, charges: [...full.value.charges, ...full.value.charges] }).ok, false);
  assert.equal(reserveResources(full.value, authority, ready, { ...intent, deadline: 92_000, target: huge, peak: huge.budget }, 2000).ok, false);
});
