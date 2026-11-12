import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { openLifecycleAppIndex } from "../../src/server/deployment/lifecycle-app-index.ts";
import { parseLifecycleEnvelope } from "../../src/server/deployment/lifecycle-envelope.ts";
import { openLifecycleEnvelopeStore } from "../../src/server/deployment/lifecycle-envelope-store.ts";
import type { JournalValue } from "../../src/server/deployment/journal.ts";

import { fixture, template, commit, generation } from "./http-test-fixture.ts";

test("request, lifecycle fence and ticket are durable together; restart does not reconstruct a moving plan", async (t) => {
  const { path, index, ports, builds } = await fixture(t);
  const request = randomUUID();
  await assert.rejects(index.prepareHttpRollout("shop", request, commit, ports), /retained build/);
  await index.prepareBuild("shop", commit, builds);
  await assert.rejects(index.prepareHttpRollout("shop", request, commit, { ...ports, retain: async (content) => { await ports.retain(content); throw new Error("lost retention acknowledgement"); } }), /lost retention/);
  assert.equal(await index.httpOperation("shop", request), undefined);
  const operation = await index.prepareHttpRollout("shop", request, commit, ports);
  assert.equal(operation.phase, "prepared");
  assert.equal(operation.deadline, 91_000);
  assert.equal(operation.previous, null);
  assert.equal(operation.action, operation.ticket);
  await assert.rejects(index.recordHttpNativeIntent("shop", operation.ticket, { effect: "apply", expected: null, plan: operation.plan, deadline: operation.deadline }), /no matching durable admission/);
  await index.close();
  const recovered = await openLifecycleAppIndex(path);
  t.after(() => recovered.close());
  assert.deepEqual(await recovered.prepareHttpRollout("shop", request, commit, { now: () => 999_999, preview: () => { throw new Error("moving platform inputs must not be read"); }, retain: () => { throw new Error("retained plan must not be replaced"); } }), operation);
  await assert.rejects(recovered.prepareHttpRollout("shop", request, "b".repeat(40), ports), /conflicting commit/);
  await assert.rejects(recovered.prepareHttpRollout("shop", randomUUID(), commit, ports), /busy or fenced/);
});

test("admission uses the recorded plan and deadline before a stable native CAS intent can be written", async (t) => {
  const { path, index, ports, builds } = await fixture(t);
  await index.prepareBuild("shop", commit, builds);
  const operation = await index.prepareHttpRollout("shop", randomUUID(), commit, ports);
  const admitted = await index.admitHttpRollout("shop", operation.ticket, { ...ports, now: () => 2000 });
  assert.equal(admitted?.phase, "admitted");
  assert.equal(admitted.deadline, operation.deadline);
  assert.equal((await index.resourceSnapshot())?.charges[0]?.deadline, operation.deadline);
  const intent = { effect: "apply" as const, expected: { id: "s".repeat(25), version: 42 }, plan: operation.plan, deadline: operation.deadline };
  assert.equal((await index.recordHttpNativeIntent("shop", operation.ticket, intent)).status, "new");
  await assert.rejects(index.recordHttpNativeIntent("shop", operation.ticket, { ...intent, expected: { ...intent.expected, version: 99 } }), /versions cannot be refreshed/);
  await index.close();
  const recovered = await openLifecycleAppIndex(path);
  t.after(() => recovered.close());
  const replay = await recovered.recordHttpNativeIntent("shop", operation.ticket, intent);
  assert.equal(replay.status, "reconcile");
  assert.deepEqual(replay.request.steps, [intent]);
  assert.equal(replay.request.deadline, 91_000);
  assert.equal(replay.request.verified, null);
});

test("expired or corrupt plans never acquire capacity and never gain a native intent", async (t) => {
  const { index, ports, builds } = await fixture(t);
  await index.prepareBuild("shop", commit, builds);
  const operation = await index.prepareHttpRollout("shop", randomUUID(), commit, ports);
  await assert.rejects(index.admitHttpRollout("shop", operation.ticket, { ...ports, read: () => Promise.resolve("{}") }), /integrity failed/);
  await assert.rejects(index.admitHttpRollout("shop", operation.ticket, { ...ports, now: () => operation.deadline }), /deadline expired/);
  assert.equal(await index.resourceSnapshot(), null);
  assert.equal((await index.httpOperation("shop", operation.request))?.phase, "prepared");
  assert.deepEqual((await index.httpOperation("shop", operation.request))?.steps, []);
});

test("an unacknowledged intent commit reopens the same request without issuing another ticket", async () => {
  // eslint-disable-next-line functional/no-let -- inject a lost acknowledgement after durable replacement
  let value: JournalValue | undefined;
  // eslint-disable-next-line functional/no-let -- only the HTTP write loses its reply
  let lose = false;
  const read = () => Promise.resolve(value);
  const store = openLifecycleEnvelopeStore({ read, write: (next) => { value = structuredClone(next); return lose ? Promise.reject(new Error("lost intent acknowledgement")) : Promise.resolve(); } }, (identity) => Promise.resolve({ ...identity, status: "applied" }));
  await store.initialize("shop", template.registration.incarnation);
  const ticket = await store.reserveRegistration(generation, "swarm");
  await store.submitRegistration(ticket, generation); await store.reconcileRegistration(ticket, generation);
  const requested = { request: randomUUID(), plan: "b".repeat(64), commit, service: "web" };
  lose = true;
  await assert.rejects(store.prepareHttp(requested, 1000), /lost intent/);
  await assert.rejects(store.read(), /uncertain/);
  const recovered = openLifecycleEnvelopeStore({ read, write: () => { throw new Error("recovery must not issue another ticket"); } });
  const operation = await recovered.prepareHttp(requested, 999_999);
  assert.equal(operation.deadline, 91_000);
  assert.equal(operation.ticket, template.registration.incarnation + ":2");
  const envelope = parseLifecycleEnvelope(value);
  assert.ok(envelope.ok);
  assert.equal(envelope.value.operations[0]?.action, operation.action);
  assert.equal(envelope.value.tickets.nextTicket, 3);
  assert.equal(envelope.value.http?.active, null);
});


test("SIGKILL after native intent preserves the original version and charged deadline without dispatch", { timeout: 10000 }, async (t) => {
  const { path, index, ports, builds } = await fixture(t);
  await index.prepareBuild("shop", commit, builds);
  const operation = await index.prepareHttpRollout("shop", randomUUID(), commit, ports);
  await index.close();
  const source = `
    import { openLifecycleAppIndex } from ${JSON.stringify(new URL("../../src/server/deployment/lifecycle-app-index.ts", import.meta.url).href)};
    import { openArtifactStore } from ${JSON.stringify(new URL("../../src/server/deployment/artifact-store.ts", import.meta.url).href)};
    import { dirname, join } from "node:path";
    const index = await openLifecycleAppIndex(process.argv[1]);
    const operation = JSON.parse(process.argv[2]);
    const artifacts = await openArtifactStore(join(dirname(process.argv[1]), "artifacts"));
    await index.admitHttpRollout("shop", operation.ticket, { ...artifacts, now: () => 2000,
      observeHost: (host) => Promise.resolve({ status: "ready", engine: "29.9.3", api: "1.56", node: host.node, cluster: host.cluster, network: host.network.id,
        capacity: { cpu: host.profile.cpu_millicores, memory: host.profile.memory_bytes }, standing: { cpu: host.profile.platform_cpu_millicores, memory: host.profile.platform_memory_bytes } }),
    });
    const intent = { effect: "apply", plan: operation.plan, expected: null, deadline: operation.deadline };
    await index.recordHttpNativeIntent("shop", operation.ticket, intent);
    console.log("durable-native-intent");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, path, JSON.stringify(operation)], { stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  try {
    await Promise.race([once(lines, "line", { signal: AbortSignal.timeout(5000) }), exited.then(() => { throw new Error("coordinator exited before intent checkpoint"); })]);
    await assert.rejects(openLifecycleAppIndex(path), /locked/);
    child.kill("SIGKILL"); await exited;
    const recovered = await openLifecycleAppIndex(path);
    try {
      const record = await recovered.httpOperation("shop", operation.request);
      assert.equal(record?.phase, "applying");
      assert.equal(record.deadline, operation.deadline);
      assert.deepEqual(record.steps, [{ effect: "apply", plan: operation.plan, expected: null, deadline: operation.deadline }]);
      assert.equal((await recovered.resourceSnapshot())?.charges[0]?.deadline, operation.deadline);
      assert.equal((await recovered.recordHttpNativeIntent("shop", operation.ticket, record.steps[0] ?? { effect: "apply", plan: operation.plan, expected: null, deadline: operation.deadline })).status, "reconcile");
    } finally { await recovered.close(); }
  } finally { lines.close(); child.kill("SIGKILL"); await exited; }
});
