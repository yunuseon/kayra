/* eslint-disable functional/prefer-immutable-types -- test buffers and fake native request tuples */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseMigrationProbe } from "../../src/contracts/migration-probe.ts";
import { migrationProbeOutput } from "../../src/server/runtime/migration-probe-output.ts";
import { oneShotJob } from "../../src/server/runtime/one-shot-job.ts";
import { jobPlan, jobRuntime } from "./one-shot-fixture.ts";

const frame = (value: string | Uint8Array, stream = 1) => {
  const bytes = Buffer.from(value); const header = Buffer.alloc(8);
  header.writeUInt8(stream); header.writeUInt32BE(bytes.byteLength, 4);
  return Buffer.concat([header, bytes]);
};

test("a status probe declares exactly one versioned outcome without arbitrary diagnostic fields", () => {
  for (const outcome of ["applied", "not-applied", "unknown"]) assert.deepEqual(parseMigrationProbe(JSON.stringify({ version: 1, outcome })), { ok: true, value: { version: 1, outcome } });
  for (const text of ["applied", '{"outcome":"applied"}', '{"version":1,"outcome":"applied","secret":"private"}', '{"version":1,"outcome":"applied"}\n{}', "x".repeat(257)]) {
    const parsed = parseMigrationProbe(text); assert.equal(parsed.ok, false); assert.ok(!JSON.stringify(parsed).includes("private"));
  }
});

test("only complete bounded non-TTY stdout frames become semantic evidence", () => {
  const value = '{"version":1,"outcome":"applied"}';
  assert.equal(migrationProbeOutput(frame(value)), "applied");
  assert.equal(migrationProbeOutput(Buffer.concat([frame(value.slice(0, 15)), frame(value.slice(15))])), "applied");
  for (const invalid of [Buffer.from(value), frame(value, 2), frame(value).subarray(0, -1), frame(Buffer.from([0xff])), Buffer.alloc(1025), frame(value + "\n{}"), frame("")]) assert.equal(migrationProbeOutput(invalid), "unknown");
  assert.equal(migrationProbeOutput(frame('{"version":1,"outcome":"not-applied"}')), "not-applied");
});

test("probe output is read only after successful exit and normalized before crossing the runtime boundary", async () => {
  const plan = jobPlan(); const probe = { ...plan, scope: { ...plan.scope, purpose: "probe" as const } };
  const lab = jobRuntime(probe);
  await lab.native.create(probe, { TOKEN: "secret-value" }); const created = await lab.native.observe(probe); assert.equal(created.status, "owned");
  const logs = { request: async (...args: Parameters<typeof lab.api.request>) => args[1].includes("/logs?")
    ? { status: 200, value: frame('{"version":1,"outcome":"applied"}') } : lab.api.request(...args) };
  const native = oneShotJob(logs, lab.clock);
  assert.equal((await native.observe(probe)).status, "owned");
  assert.equal(await native.start(probe, created.id), "acknowledged");
  const done = await native.observe(probe); assert.equal(done.status, "owned"); assert.equal(done.probe, "applied");
  assert.ok(!JSON.stringify(done).includes("secret-value"));
  lab.state("exited", 1); const failed = await native.observe(probe); assert.equal(failed.status, "owned"); assert.equal(failed.probe, null);
});

test("unavailable or malformed probe output stays unknown even after a successful process exit", async () => {
  const plan = jobPlan(); const probe = { ...plan, scope: { ...plan.scope, purpose: "probe" as const } }; const lab = jobRuntime(probe);
  await lab.native.create(probe, { TOKEN: "secret-value" }); const created = await lab.native.observe(probe); assert.equal(created.status, "owned"); await lab.native.start(probe, created.id);
  const native = oneShotJob({ request: async (...args: Parameters<typeof lab.api.request>) => args[1].includes("/logs?")
    ? { status: 200, value: frame("PRIVATE-DIAGNOSTIC") } : lab.api.request(...args) }, lab.clock);
  const done = await native.observe(probe); assert.equal(done.status, "owned"); assert.equal(done.state, "succeeded"); assert.equal(done.probe, "unknown");
  assert.ok(!JSON.stringify(done).includes("PRIVATE-DIAGNOSTIC"));
});
