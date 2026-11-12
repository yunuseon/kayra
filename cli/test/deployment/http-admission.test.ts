import { strict as assert } from "node:assert";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { httpRecoveryPeak } from "../../src/server/deployment/http-admission.ts";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { recoveryFixture } from "./http-recovery-fixture.ts";

test("HTTP peak includes restored A rather than only the normal A+B replacement", () => {
  assert.deepEqual(httpRecoveryPeak({ cpu: 200, memory: 128 }, { cpu: 100, memory: 64 }), { cpu: 400, memory: 256 });
  assert.deepEqual(httpRecoveryPeak({ cpu: 100, memory: 64 }, null), { cpu: 100, memory: 64 });
});

test("a host that fits normal replacement but not recovery overlap refuses admission before native intent", async (t) => {
  const lab = await recoveryFixture(t, true, (plan) => ({ ...plan,
    host: { ...plan.host, profile: { ...plan.host.profile, cpu_millicores: 750 } }, grants: { ...plan.grants, cpu_millicores: 200 } }));
  const b = await lab.start("b".repeat(40));
  await assert.rejects(lab.execution.tick("shop", b.request), /insufficient declared host capacity/);
  assert.equal(lab.writes(), 1); assert.deepEqual((await lab.index.httpOperation("shop", b.request))?.steps, []);
  const book = await lab.index.resourceSnapshot();
  assert.ok(book?.charges[0] !== undefined);
  assert.equal(book.charges[0].result, "target"); assert.equal(book.charges[0].target.plan, lab.initial.plan);
  assert.equal((await lab.index.deploymentStatus("shop")).verifiedActive?.plan, lab.initial.plan);
});

test("older two-copy pending reservations cannot authorize a new native write after upgrade", async (t) => {
  const lab = await recoveryFixture(t); const b = await lab.start("b".repeat(40));
  await lab.execution.tick("shop", b.request); const snapshot = await lab.index.resourceSnapshot(); assert.ok(snapshot !== null); await lab.index.close();
  const path = join(lab.path, "state.json");
  const raw: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(typeof raw === "object" && raw !== null && "resources" in raw);
  await writeFile(path, JSON.stringify({ ...raw, resources: { ...snapshot, charges: snapshot.charges.map((charge) => ({ ...charge, peak: { cpu: 200, memory: 128 * 1024 ** 2 } })) } }));
  const reopened = await openLifecycleAppIndex(lab.path); t.after(() => reopened.close());
  const current = lab.current(); assert.equal(current.status, "owned");
  await assert.rejects(reopened.recordHttpNativeIntent("shop", b.ticket, { effect: "apply", attempt: 1, plan: b.plan, deadline: b.deadline,
    expected: { id: current.id, version: current.version } }), /reserved recovery overlap/);
  assert.deepEqual((await reopened.httpOperation("shop", b.request))?.steps, []);
  await reopened.cancelHttpRollout("shop", b.request, 3000); await reopened.reconcileHttpResources("shop", b.ticket);
  assert.equal((await reopened.resourceSnapshot())?.charges[0]?.result, "previous");
});
