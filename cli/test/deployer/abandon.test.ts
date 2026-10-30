import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { appOwner, runId } from "../../src/deployer/brand.ts";
import type { RunMeta } from "../../src/contracts/reporting.ts";
import { abandonInterruptedRuns, meta, writeMeta } from "../../src/deployer/runs/store.ts";
import { commit, must, name } from "./support.ts";

test("legacy startup abandons unfinished runs while preserving terminal and malformed records", () => {
  const runs = mkdtempSync(join(tmpdir(), "kayra-abandon-"));
  const owner = appOwner(name("shop"));
  const queued: RunMeta = { id: must(runId("20261018T095848Z-0f9e8d")), owner, what: "deploy main", why: "push", state: "queued", started: "2026-10-18T09:58:48.000Z" };
  const running: RunMeta = { ...queued, id: must(runId("20261018T105848Z-0f9e8d")), state: "running", sha: commit("a") };
  const done: RunMeta = { ...queued, id: must(runId("20261018T115848Z-0f9e8d")), state: "success", finished: "original" };
  const malformed = join(runs, owner, "20261018T125848Z-0f9e8d", "meta.json");
  const now = mock.fn(() => "2026-10-18T13:00:00.000Z");
  try {
    [queued, running, done].forEach((run) => { writeMeta(runs, owner, run); });
    mkdirSync(join(runs, owner, "20261018T125848Z-0f9e8d"), { recursive: true });
    writeFileSync(malformed, "not json");
    abandonInterruptedRuns(runs, now);
    const failure = { state: "failure", error: "the deployer restarted before this run ended", finished: "2026-10-18T13:00:00.000Z" };
    deepStrictEqual(meta(runs, owner, queued.id), { ...queued, ...failure });
    deepStrictEqual(meta(runs, owner, running.id), { ...running, ...failure });
    deepStrictEqual(meta(runs, owner, done.id), done);
    strictEqual(readFileSync(malformed, "utf8"), "not json");
    strictEqual(now.mock.callCount(), 2);
  } finally {
    rmSync(runs, { recursive: true, force: true });
  }
});

test("legacy abandonment leaves directory read errors visible to startup", () => {
  const dir = mkdtempSync(join(tmpdir(), "kayra-abandon-"));
  const runs = join(dir, "runs");
  try {
    writeFileSync(runs, "not a directory");
    throws(() => { abandonInterruptedRuns(runs, () => "unused"); });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
