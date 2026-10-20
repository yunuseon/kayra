import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { releasesAnswer, runsAnswer } from "../../src/deployer/ctl/answers.ts";
import { runId } from "../../src/deployer/brand.ts";
import { releases, type RunMeta } from "../../src/deployer/runs/records.ts";
import { appName, serverName } from "../../src/core/fleet/brand.ts";
import { flat } from "../../src/core/text/spans.ts";
import { runSchema } from "../../src/core/ctl/answers.ts";
import { draw } from "../../src/clients/cli/views.ts";
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

/** ctl as a child that may take its time, while this process plays the control port. */
const ctlLater = (...args: readonly string[]) =>
  new Promise<{ readonly code: number | null; readonly stdout: string }>((resolve) => {
    const child = spawn("node", [join(import.meta.dirname, "../../src/deployer/main.ts"), "ctl", ...args], { env: { ...process.env, PLATFORM_DIR: platform } });
    const out = { text: "" };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      // eslint-disable-next-line functional/immutable-data -- the child's output, gathered
      out.text += chunk;
    });
    child.on("close", (code) => { resolve({ code, stdout: out.text }); });
  });

test("ctl deploy follows its run: the log as it grows, then what runs where; --json ends with the run as data", async () => {
  const id = must(runId("20261018T120000Z-abcdef"));
  const dir = join(platform, "runs", "shop", id);
  const at = (state: RunMeta["state"], more: Partial<RunMeta> = {}): RunMeta =>
    ({ id, owner: "shop", what: "deploy main", why: "deploy", state, started: "2026-10-18T12:00:00.000Z", ...more });
  const control = createServer((_, response) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify(at("queued")));
    writeFileSync(join(dir, "log"), "12:00:00 Deploying shop at main\n");
    response.writeHead(202).end(`${JSON.stringify({ id, owner: "shop", state: "queued" })}\n`);
    setTimeout(() => {
      appendFileSync(join(dir, "log"), "12:00:02 ready  https://www.shop.example.com/  200\n");
      writeFileSync(join(dir, "meta.json"), JSON.stringify(at("success", {
        sha: commit("a"), finished: "2026-10-18T12:00:03.000Z", urls: ["https://www.shop.example.com/"],
        checks: [{ url: "https://www.shop.example.com/", status: 200, ok: true }],
      })));
    }, 1_500);
  });
  await new Promise<void>((resolve) => { control.listen(8091, "127.0.0.1", resolve); });
  try {
    const followed = await ctlLater("deploy", "shop");
    strictEqual(followed.code, 0);
    deepStrictEqual(followed.stdout.split("\n"), [
      "12:00:00 Deploying shop at main",
      "12:00:02 ready  https://www.shop.example.com/  200",
      `✓ shop aaaaaaa deployed (run ${id})`,
      "  https://www.shop.example.com/",
      "",
    ]);
    const json = await ctlLater("deploy", "shop", "--json");
    strictEqual(json.code, 0);
    deepStrictEqual(runSchema.parse(JSON.parse(json.stdout)).urls, ["https://www.shop.example.com/"]);
  } finally {
    control.close();
  }
});

test("ctl deploy: a failed run exits 1 with its reason; a superseded one says what replaced it", async () => {
  const id = must(runId("20261018T130000Z-fa11ed"));
  const dir = join(platform, "runs", "shop", id);
  // eslint-disable-next-line functional/prefer-immutable-types -- the fake control port's next answer
  const end: { value: RunMeta["state"] } = { value: "failure" };
  const control = createServer((_, response) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "log"), "");
    writeFileSync(join(dir, "meta.json"), JSON.stringify({
      id, owner: "shop", what: "deploy main", why: "deploy", state: end.value, started: "2026-10-18T13:00:00.000Z", finished: "2026-10-18T13:00:01.000Z",
      ...(end.value === "failure" ? { sha: commit("b"), error: "refused by the compose policy" } : {}),
    }));
    response.writeHead(202).end(JSON.stringify({ id, owner: "shop", state: "queued" }));
  });
  await new Promise<void>((resolve) => { control.listen(8091, "127.0.0.1", resolve); });
  try {
    const failed = await ctlLater("deploy", "shop");
    strictEqual(failed.code, 1);
    strictEqual(failed.stdout, `✗ shop bbbbbbb: refused by the compose policy (run ${id})\n`);
    // eslint-disable-next-line functional/immutable-data -- the fake control port's next answer
    end.value = "superseded";
    const replaced = await ctlLater("deploy", "shop");
    strictEqual(replaced.code, 1);
    strictEqual(replaced.stdout, `↷ shop: a newer request replaced this one before it started (run ${id})\n`);
  } finally {
    control.close();
  }
});
