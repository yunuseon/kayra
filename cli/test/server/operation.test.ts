/* eslint-disable functional/no-let -- test fixtures model time and external effects */
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openJournal } from "../../src/server/deployment/journal.ts";
import { parseOperationRecord, singleEffectCoordinator, type ActionPort, type ObservationStatus, type OperationRequest } from "../../src/server/deployment/operation.ts";

const request: OperationRequest = { operationId: "11111111-1111-4111-8111-111111111111", actionId: "22222222-2222-4222-8222-222222222222", planDigest: "a".repeat(64), deadline: 5_000, replay: "never" };
const observed = (status: ObservationStatus) => ({ operationId: request.operationId, actionId: request.actionId, planDigest: request.planDigest, status });
const allow = () => Promise.resolve(true);
const directory = async () => mkdtemp(join(tmpdir(), "kayra-operation-"));
const recorded = async (journal: { readonly read: () => Promise<unknown> }) => {
  const result = parseOperationRecord(await journal.read());
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

test("record validation admits only fixed identity and state fields", () => {
  const record = { ...request, version: 1, attempts: 1, phase: "intent" };
  assert.equal(parseOperationRecord(record).ok, true);
  assert.equal(parseOperationRecord({ ...record, env: { PASSWORD: "secret" } }).ok, false);
  assert.equal(parseOperationRecord({ ...record, message: "secret" }).ok, false);
  assert.equal(parseOperationRecord({ ...record, actionId: "database-password" }).ok, false);
  assert.equal(parseOperationRecord({ ...record, deadline: Infinity }).ok, false);
  assert.equal(parseOperationRecord({ ...record, attempts: 2 }).ok, false);
  assert.equal(parseOperationRecord({ ...record, reason: "ambiguous" }).ok, false);
  assert.equal(parseOperationRecord({ ...record, phase: "held" }).ok, false);
});

test("an interrupted unsafe effect is observed on restart and never reissued if absent", async () => {
  const dir = await directory();
  try {
    const journal = await openJournal(dir);
    const port: ActionPort = { authorize: allow, execute: () => Promise.reject(new Error("crashed before effect")), observe: () => Promise.resolve(observed("absent")) };
    const first = singleEffectCoordinator(journal, port, () => 1000);
    const result = await first.start(request);
    assert.equal(result.kind, "pending");
    assert.equal((await recorded(journal)).phase, "intent");
    await journal.close();
    const reopened = await openJournal(dir);
    let calls = 0;
    const resumed = singleEffectCoordinator(reopened, { authorize: allow, execute: () => { calls += 1; return Promise.resolve(); }, observe: () => Promise.resolve(observed("absent")) }, () => 2000);
    const recovered = await resumed.reconcile();
    assert.equal(recovered.kind, "held");
    assert.equal(recovered.record.reason, "ambiguous");
    assert.equal(calls, 0);
    assert.equal(recovered.record.actionId, request.actionId);
    assert.equal(recovered.record.deadline, request.deadline);
    await reopened.close();
  } finally { await rm(dir, { force: true, recursive: true }); }
});

test("an effect that completed before interruption is verified from durable runtime evidence", async () => {
  const dir = await directory();
  try {
    let applied = false;
    const journal = await openJournal(dir);
    const first = singleEffectCoordinator(journal, { authorize: allow, execute: () => { applied = true; return Promise.reject(new Error("crash after effect")); }, observe: () => Promise.resolve(observed("unknown")) }, () => 1000);
    assert.equal((await first.start(request)).kind, "pending");
    await journal.close();
    const reopened = await openJournal(dir);
    const coordinator = singleEffectCoordinator(reopened, { authorize: allow, execute: () => { throw new Error("must not reissue"); }, observe: (record) => { assert.equal(record.actionId, request.actionId); return Promise.resolve(observed(applied ? "applied" : "absent")); } }, () => 2000);
    const recovered = await coordinator.reconcile();
    assert.equal(recovered.kind, "verified");
    assert.equal(recovered.record.deadline, 5000);
    await reopened.close();
  } finally { await rm(dir, { force: true, recursive: true }); }
});

test("safe retry is recorded before effect and bounded by the original deadline", async () => {
  const dir = await directory();
  try {
    const journal = await openJournal(dir);
    let attempts = 0;
    let observation: ObservationStatus = "failed";
    const port: ActionPort = { authorize: allow, execute: async (record) => { attempts += 1; assert.equal((await recorded(journal)).attempts, record.attempts); }, observe: () => Promise.resolve(observed(observation)) };
    const first = singleEffectCoordinator(journal, port, () => 1000);
    assert.equal((await first.start({ ...request, replay: "safe" })).kind, "pending");
    assert.equal(attempts, 1);
    await journal.close();
    const reopened = await openJournal(dir);
    const retryPort: ActionPort = { authorize: allow, execute: async (record) => { attempts += 1; assert.equal((await recorded(reopened)).attempts, 2); assert.equal(record.deadline, 5000); }, observe: () => Promise.resolve(observed(observation)) };
    const resumed = singleEffectCoordinator(reopened, retryPort, () => 2000);
    assert.equal((await resumed.reconcile()).kind, "pending");
    assert.equal(attempts, 2);
    observation = "running";
    assert.equal((await resumed.reconcile()).kind, "pending");
    observation = "failed";
    assert.equal((await resumed.reconcile()).kind, "held");
    assert.equal(attempts, 2);
    await reopened.close();
  } finally { await rm(dir, { force: true, recursive: true }); }
});

test("expired deadlines and failed intent writes never reach the adapter", async () => {
  const dir = await directory();
  try {
    const journal = await openJournal(dir);
    let calls = 0;
    const port: ActionPort = { authorize: allow, execute: () => { calls += 1; return Promise.resolve(); }, observe: () => Promise.resolve(observed("absent")) };
    const bad = singleEffectCoordinator({ read: () => Promise.resolve(undefined), write: () => Promise.reject(new Error("disk failed")) }, port, () => 1000);
    await assert.rejects(bad.start(request), /disk failed/);
    const late = singleEffectCoordinator(journal, port, () => 5000);
    await assert.rejects(late.start(request), /deadline has expired/);
    assert.equal(calls, 0);
    await journal.close();
  } finally { await rm(dir, { force: true, recursive: true }); }
});

test("concurrent requests cannot both begin on a single journal owner", async () => {
  const dir = await directory();
  try {
    const journal = await openJournal(dir);
    let calls = 0;
    const coordinator = singleEffectCoordinator(journal, { authorize: allow, execute: () => { calls += 1; return Promise.resolve(); }, observe: () => Promise.resolve(observed("running")) }, () => 1000);
    const results = await Promise.allSettled([coordinator.start(request), coordinator.start(request)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(calls, 1);
    await journal.close();
  } finally { await rm(dir, { force: true, recursive: true }); }
});

for (const when of ["before", "after"] as const) {
  test(`SIGKILL ${when} the effect leaves a recoverable intent`, async () => {
    const dir = await directory();
    const operationUrl = new URL("../../src/server/deployment/operation.ts", import.meta.url).href;
    const journalUrl = new URL("../../src/server/deployment/journal.ts", import.meta.url).href;
    const source = `import { openJournal } from ${JSON.stringify(journalUrl)};
import { singleEffectCoordinator } from ${JSON.stringify(operationUrl)};
import { writeFile } from "node:fs/promises";
const journal = await openJournal(process.argv[1]);
const request = ${JSON.stringify(request)};
const controller = singleEffectCoordinator(journal, {
  authorize: async () => true,
  execute: async () => {
    if (process.argv[2] === "after") await writeFile(process.argv[1] + "/effect", "done");
    console.log("ready");
    await new Promise(() => {});
  },
  observe: async () => "unknown"
}, () => 1000);
await controller.start(request);`;
    const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "--eval", source, dir, when], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      const output: unknown = await Promise.race([
        once(child.stdout, "data").then((args: readonly unknown[]) => args[0]),
        once(child, "exit").then(() => { throw new Error("child exited before the interruption point"); }),
      ]);
      assert.equal(String(output).trim(), "ready");
      const exit = once(child, "exit");
      child.kill("SIGKILL");
      await exit;
      const journal = await openJournal(dir);
      const effect = await readFile(join(dir, "effect"), "utf8").catch(() => undefined);
      const resumed = singleEffectCoordinator(journal, {
        authorize: allow,
        execute: () => { throw new Error("unsafe effect must not be reissued"); },
        observe: () => Promise.resolve(observed(effect === "done" ? "applied" : "absent")),
      }, () => 2000);
      const result = await resumed.reconcile();
      assert.equal(result.kind, when === "after" ? "verified" : "held");
      assert.equal(result.record.actionId, request.actionId);
      assert.equal(result.record.deadline, request.deadline);
      await journal.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await rm(dir, { force: true, recursive: true });
    }
  });
}

test("a journal handle cannot be owned by multiple coordinators", async () => {
  const dir = await directory();
  try {
    const journal = await openJournal(dir);
    const port: ActionPort = { authorize: allow, execute: () => Promise.resolve(), observe: () => Promise.resolve(observed("unknown")) };
    singleEffectCoordinator(journal, port, () => 1000);
    assert.throws(() => singleEffectCoordinator(journal, port, () => 1000), /already has a coordinator/);
    await journal.close();
  } finally { await rm(dir, { force: true, recursive: true }); }
});

test("the adapter must authorize the plan and replay policy before any execution", async () => {
  const dir = await directory();
  try {
    const journal = await openJournal(dir);
    let calls = 0;
    const coordinator = singleEffectCoordinator(journal, { authorize: () => Promise.resolve(false), execute: () => { calls += 1; return Promise.resolve(); }, observe: () => Promise.resolve(observed("unknown")) }, () => 1000);
    const result = await coordinator.start(request);
    assert.equal(result.kind, "held");
    assert.equal(result.record.reason, "unauthorized");
    assert.equal(calls, 0);
    await journal.close();
  } finally { await rm(dir, { force: true, recursive: true }); }
});

test("a mismatched or unavailable observation never verifies or retries an effect", async () => {
  for (const kind of ["wrong-action", "wrong-plan", "throw"] as const) {
    const dir = await directory();
    try {
      const journal = await openJournal(dir);
      const coordinator = singleEffectCoordinator(journal, {
        authorize: allow,
        execute: () => Promise.resolve(),
        observe: () => {
          if (kind === "throw") throw new Error("adapter unavailable");
          return Promise.resolve({ ...observed("applied"), ...(kind === "wrong-action" ? { actionId: "33333333-3333-4333-8333-333333333333" } : { planDigest: "b".repeat(64) }) });
        },
      }, () => 1000);
      await coordinator.start({ ...request, replay: "safe" });
      const result = await coordinator.reconcile();
      assert.equal(result.kind, "held");
      assert.equal(result.record.reason, "unavailable");
      assert.equal(result.record.attempts, 1);
      await journal.close();
    } finally { await rm(dir, { force: true, recursive: true }); }
  }
});

test("the deadline is checked again after delayed authorization", async () => {
  const dir = await directory();
  try {
    const journal = await openJournal(dir);
    let clock = 1000;
    let calls = 0;
    const coordinator = singleEffectCoordinator(journal, { authorize: () => { clock = 5000; return Promise.resolve(true); }, execute: () => { calls += 1; return Promise.resolve(); }, observe: () => Promise.resolve(observed("unknown")) }, () => clock);
    const result = await coordinator.start(request);
    assert.equal(result.kind, "held");
    assert.equal(result.record.reason, "expired");
    assert.equal(calls, 0);
    await journal.close();
  } finally { await rm(dir, { force: true, recursive: true }); }
});

test("corrupt journal records never reach the action port", async () => {
  const dir = await directory();
  try {
    const journal = await openJournal(dir);
    await journal.write({ ...request, version: 1, attempts: 1, phase: "intent", secret: "do not persist" });
    let calls = 0;
    const coordinator = singleEffectCoordinator(journal, { authorize: () => { calls += 1; return Promise.resolve(true); }, execute: () => { calls += 1; return Promise.resolve(); }, observe: () => { calls += 1; return Promise.resolve(observed("applied")); } }, () => 1000);
    await assert.rejects(coordinator.reconcile(), /invalid operation journal/);
    assert.equal(calls, 0);
    await journal.close();
  } finally { await rm(dir, { force: true, recursive: true }); }
});

test("an expired persisted deadline cannot be reset on restart even for safe replay", async () => {
  const dir = await directory();
  try {
    const journal = await openJournal(dir);
    const port: ActionPort = { authorize: allow, execute: () => Promise.resolve(), observe: () => Promise.resolve(observed("absent")) };
    await singleEffectCoordinator(journal, port, () => 1000).start({ ...request, replay: "safe" });
    await journal.close();
    const reopened = await openJournal(dir);
    let calls = 0;
    const coordinator = singleEffectCoordinator(reopened, { ...port, execute: () => { calls += 1; return Promise.resolve(); } }, () => 5000);
    const result = await coordinator.reconcile();
    assert.equal(result.kind, "held");
    assert.equal(result.record.reason, "expired");
    assert.equal(result.record.deadline, 5000);
    assert.equal(calls, 0);
    await reopened.close();
  } finally { await rm(dir, { force: true, recursive: true }); }
});

test("an absent safe action is ambiguous and is not automatically reissued", async () => {
  const dir = await directory();
  try {
    const journal = await openJournal(dir);
    let calls = 0;
    const coordinator = singleEffectCoordinator(journal, { authorize: allow, execute: () => { calls += 1; return Promise.resolve(); }, observe: () => Promise.resolve(observed("absent")) }, () => 1000);
    await coordinator.start({ ...request, replay: "safe" });
    assert.equal((await coordinator.reconcile()).kind, "held");
    assert.equal(calls, 1);
    await journal.close();
  } finally { await rm(dir, { force: true, recursive: true }); }
});

for (const hung of ["authorize", "execute", "observe"] as const) {
  test(`a hung ${hung} is aborted at its absolute deadline and cannot trigger another effect`, async () => {
    const dir = await directory();
    try {
      const journal = await openJournal(dir);
      let aborted = false;
      let effects = 0;
      // eslint-disable-next-line functional/prefer-immutable-types -- AbortSignal is a cancellation primitive.
      const hang = (signal: AbortSignal) => {
        signal.addEventListener("abort", () => { aborted = true; }, { once: true });
        return new Promise<never>(() => undefined);
      };
      const port: ActionPort = {
        authorize: (_record, signal) => hung === "authorize" ? hang(signal) : allow(),
        execute: (_record, signal) => { effects += 1; return hung === "execute" ? hang(signal) : Promise.resolve(); },
        observe: (_record, signal) => hung === "observe" ? hang(signal) : Promise.resolve(observed("running")),
      };
      const deadline = Date.now() + 200;
      const coordinator = singleEffectCoordinator(journal, port, Date.now);
      const started = await coordinator.start({ ...request, deadline, replay: "safe" });
      const result = hung === "observe" ? await coordinator.reconcile() : started;
      assert.equal(result.kind, "held");
      assert.equal(result.record.reason, "expired");
      assert.equal(result.record.deadline, deadline);
      assert.equal(aborted, true);
      const count = effects;
      assert.equal((await coordinator.reconcile()).kind, "held");
      assert.equal(effects, count);
      assert.equal(effects, hung === "authorize" ? 0 : 1);
      await journal.close();
    } finally { await rm(dir, { force: true, recursive: true }); }
  });
}

test("an adapter resolving after it ignores cancellation cannot clear a held operation", async () => {
  const dir = await directory();
  try {
    const journal = await openJournal(dir);
    let finished = false;
    let calls = 0;
    const coordinator = singleEffectCoordinator(journal, {
      authorize: allow,
      execute: () => { calls += 1; return new Promise<void>((resolve) => { setTimeout(() => { finished = true; resolve(); }, 250); }); },
      observe: () => Promise.resolve(observed("applied")),
    }, Date.now);
    const result = await coordinator.start({ ...request, deadline: Date.now() + 100, replay: "safe" });
    assert.equal(result.kind, "held");
    await new Promise<void>((resolve) => { setTimeout(resolve, 250); });
    assert.equal(finished, true);
    assert.equal((await coordinator.reconcile()).kind, "held");
    assert.equal((await recorded(journal)).phase, "held");
    assert.equal(calls, 1);
    await journal.close();
  } finally { await rm(dir, { force: true, recursive: true }); }
});

test("adapter code cannot mutate a validated intent after it is persisted", async () => {
  const dir = await directory();
  try {
    const journal = await openJournal(dir);
    let mutationSucceeded = true;
    const coordinator = singleEffectCoordinator(journal, {
      authorize: (record) => { mutationSucceeded = Reflect.set(record, "deadline", 9000); return Promise.resolve(true); },
      execute: (record) => { assert.equal(record.deadline, request.deadline); return Promise.resolve(); },
      observe: () => Promise.resolve(observed("running")),
    }, () => 1000);
    await coordinator.start(request);
    assert.equal(mutationSucceeded, false);
    assert.equal((await recorded(journal)).deadline, request.deadline);
    await journal.close();
  } finally { await rm(dir, { force: true, recursive: true }); }
});

test("a separately bounded diagnostic observation can verify an expired intent without extending execution", async () => {
  for (const status of ["applied", "failed"] as const) {
    const dir = await directory();
    try {
      const journal = await openJournal(dir);
      const startPort: ActionPort = { authorize: allow, execute: () => Promise.resolve(), observe: () => Promise.resolve(observed(status)) };
      await singleEffectCoordinator(journal, startPort, () => 1000).start({ ...request, replay: "safe" });
      await journal.close();
      const reopened = await openJournal(dir);
      let calls = 0;
      const coordinator = singleEffectCoordinator(reopened, { ...startPort, execute: () => { calls += 1; return Promise.resolve(); } }, () => 6000);
      const result = await coordinator.reconcile(6500);
      assert.equal(result.kind, status === "applied" ? "verified" : "held");
      assert.equal(result.record.deadline, 5000);
      assert.equal(calls, 0);
      await reopened.close();
    } finally { await rm(dir, { force: true, recursive: true }); }
  }
});
