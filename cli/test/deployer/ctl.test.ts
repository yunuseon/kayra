import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { releasesAnswer, runsAnswer } from "../../src/deployer/answers.ts";
import { runId } from "../../src/deployer/brand.ts";
import { releases, type RunMeta } from "../../src/deployer/records.ts";
import { appName, serverName } from "../../src/core/fleet/brand.ts";
import { flat } from "../../src/core/text/spans.ts";
import { draw } from "../../src/core/present/views.ts";
import { commit, must, name } from "./support.ts";

const platform = mkdtempSync(join(tmpdir(), "kayra-ctl-"));
after(() => {
  rmSync(platform, { recursive: true, force: true });
});

const done: RunMeta = {
  id: must(runId("20261018T095848Z-0f9e8d")),
  owner: "shop",
  what: "deploy main",
  why: "push",
  sha: commit("a"),
  state: "success",
  started: "2026-10-18T09:58:48.000Z",
  finished: "2026-10-18T10:00:00.400Z",
};
const running: RunMeta = { id: must(runId("20261018T115948Z-77aa00")), owner: "shop", what: "deploy v2", why: "deploy", state: "running", started: "2026-10-18T11:59:48.120Z" };

[done, running].forEach((run) => {
  mkdirSync(join(platform, "runs", "shop", run.id), { recursive: true });
  writeFileSync(join(platform, "runs", "shop", run.id, "meta.json"), JSON.stringify(run));
});
mkdirSync(join(platform, "releases", "shop"), { recursive: true });
mkdirSync(join(platform, "releases", "solo"), { recursive: true });
writeFileSync(join(platform, "releases", "shop", `20261016T080000Z-${commit("b")}.env`), "");
writeFileSync(join(platform, "releases", "shop", `20261018T100000Z-${commit("a")}.env`), "");
writeFileSync(join(platform, "releases", "solo", `20261018T100000Z-${commit("c")}.env`), "");

const ctl = (...args: readonly string[]): { readonly code: number | null; readonly stdout: string; readonly stderr: string } => {
  const exit = spawnSync("node", [join(import.meta.dirname, "../../src/deployer/main.ts"), "ctl", ...args], {
    env: { ...process.env, PLATFORM_DIR: platform },
    encoding: "utf8",
  });
  return { code: exit.status, stdout: exit.stdout, stderr: exit.stderr };
};

const about = { app: must(appName("shop")), server: must(serverName("forge")) };
const now = Date.parse("2026-10-18T12:00:00Z");

test("ctl runs --json: the newest runs first, with what runs now; times as ISO 8601", () => {
  const answer = ctl("runs", "shop", "--json");
  strictEqual(answer.code, 0);
  deepStrictEqual(JSON.parse(answer.stdout), {
    app: "shop",
    live: { sha: commit("a"), time: "2026-10-18T10:00:00Z" },
    runs: [
      { id: running.id, state: "running", why: "deploy", what: "deploy v2", started: running.started },
      { id: done.id, state: "success", why: "push", what: "deploy main", sha: commit("a"), started: done.started, finished: done.finished },
    ],
  });
  strictEqual(flat(draw({ view: "runs", ...about }, answer.stdout, now)[0] ?? ""), "shop on forge · live aaaaaaa since 2h ago");
});

test("ctl runs without --json says what it always said", () => {
  const answer = ctl("runs", "shop");
  strictEqual(answer.stdout.split("\n")[1], `${done.id}  success   aaaaaaaaaaaa  push      deploy main`);
});

test("ctl rollback --json lists every release, the live one first and marked; nothing earlier exits 1", () => {
  const listed = ctl("rollback", "shop", "--json");
  strictEqual(listed.code, 0);
  deepStrictEqual(JSON.parse(listed.stdout), {
    app: "shop",
    releases: [
      { sha: commit("a"), time: "2026-10-18T10:00:00Z", live: true },
      { sha: commit("b"), time: "2026-10-16T08:00:00Z", live: false },
    ],
  });
  strictEqual(flat(draw({ view: "releases", ...about }, listed.stdout, now)[0] ?? ""), "shop on forge · 2 releases");
  const alone = ctl("rollback", "solo", "--json");
  strictEqual(alone.code, 1);
  deepStrictEqual(JSON.parse(alone.stdout), { app: "solo", releases: [{ sha: commit("c"), time: "2026-10-18T10:00:00Z", live: true }] });
});

test("answers: an app never deployed has no live release; a release's time in ISO 8601", () => {
  deepStrictEqual(runsAnswer(name("shop"), [], undefined), { app: "shop", runs: [] });
  deepStrictEqual(releasesAnswer(name("shop"), releases([`20261018T100000Z-${commit("a")}.env`])), {
    app: "shop",
    releases: [{ sha: commit("a"), time: "2026-10-18T10:00:00Z", live: true }],
  });
});
