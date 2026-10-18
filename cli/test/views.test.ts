import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { appName, serverName } from "../src/brand.ts";
import type { View } from "../src/plan.ts";
import { flat, paint } from "../src/ui/line.ts";
import { ago, table } from "../src/ui/text.ts";
import { draw, logView, releasesView, runsView } from "../src/ui/views.ts";
import { must } from "./support.ts";

const about = { app: must(appName("shop")), server: must(serverName("forge")) };
const runs: View = { view: "runs", ...about };
const now = Date.parse("2026-10-18T12:00:00Z");
const a = "a".repeat(40);
const b = "b".repeat(40);
const plain = (lines: readonly (string | Parameters<typeof flat>[0])[]): readonly string[] => lines.map(flat);

test("ago rounds down to what is worth reading", () => {
  deepStrictEqual([-5_000, 59_999, 60_000, 3_599_000, 7_200_000, 172_799_000, 172_800_000].map(ago), [
    "0s ago",
    "59s ago",
    "1m ago",
    "59m ago",
    "2h ago",
    "47h ago",
    "2d ago",
  ]);
});

test("a table: columns as wide as their widest cell, nothing after a row's last", () => {
  deepStrictEqual(table([[["a"], ["bb"], ["c"]], [["ddd"], [], []], [["e"], ["f"]]]).map(flat), ["a    bb  c", "ddd", "e    f"]);
});

test("runs: what runs now, then a table with each run's state, commit, why, age, time taken and id", () => {
  const lines = runsView(
    runs,
    {
      app: "shop",
      live: { sha: a, time: "2026-10-18T10:00:00Z" },
      runs: [
        { id: "20261018T115948Z-77aa00", state: "running", why: "deploy", what: "deploy v2", started: "2026-10-18T11:59:48Z" },
        { id: "20261018T095848Z-0f9e8d", state: "success", why: "push", what: "deploy main", sha: a, started: "2026-10-18T09:58:48Z", finished: "2026-10-18T10:00:00.400Z" },
        { id: "20261017T091700Z-ab12cd", state: "failure", why: "poll", what: "deploy main", sha: b, started: "2026-10-17T09:17:00Z", finished: "2026-10-17T09:17:48Z" },
      ],
    },
    now,
  );
  deepStrictEqual(plain(lines), [
    "shop on forge · live aaaaaaa since 2h ago",
    "",
    "  STATE      COMMIT   WHY     WHEN     TOOK   RUN",
    "  ◆ running  —        deploy  12s ago  12s…   20261018T115948Z-77aa00",
    "  ✓ success  aaaaaaa  push    2h ago   1m12s  20261018T095848Z-0f9e8d",
    "  ✗ failure  bbbbbbb  poll    26h ago  48s    20261017T091700Z-ab12cd",
    "",
    "  → kayra app logs forge shop [RUN] shows a run's log, the newest by default",
  ]);
  deepStrictEqual(lines[4]?.[1], { tone: "ok", text: "✓ success" });
  deepStrictEqual(lines[5]?.[1], { tone: "bad", text: "✗ failure" });
});

test("runs of an app never deployed", () => {
  deepStrictEqual(plain(runsView(runs, { app: "shop", runs: [] }, now)), ["shop on forge · not deployed yet", "", "  no runs yet"]);
});

test("releases: the live one marked, each with its age, and the command that goes back to the newest earlier one", () => {
  const releases: View = { view: "releases", ...about };
  const both = { app: "shop", releases: [{ sha: a, time: "2026-10-18T10:00:00Z", live: true }, { sha: b, time: "2026-10-16T08:00:00Z", live: false }] };
  deepStrictEqual(plain(releasesView(releases, both, now)), [
    "shop on forge · 2 releases",
    "",
    "    COMMIT   DEPLOYED",
    "  ● aaaaaaa  2h ago    live",
    "    bbbbbbb  2d ago",
    "",
    "  → kayra app rollback forge shop bbbbbbb deploys that one again",
  ]);
  const alone = { app: "shop", releases: both.releases.slice(0, 1) };
  deepStrictEqual(plain(releasesView(releases, alone, now)).slice(-1), ["  nothing earlier to roll back to"]);
});

const log = [
  "09:58:48 Deploying shop at main",
  "09:58:49 ── main is aaaa",
  "09:59:10 #5 WARN: something deprecated",
  "",
  "09:59:51 Admission: policy failed (exit 1)\r",
  "no stamp: error",
  "",
].join("\n");

test("a log: errors and warnings marked, the deployer's times muted", () => {
  const lines = logView(log);
  deepStrictEqual(lines[2], [{ tone: "muted", text: "09:59:10 " }, { tone: "warn", text: "#5 WARN: something deprecated" }]);
  deepStrictEqual(lines[4], [{ tone: "muted", text: "09:59:51 " }, { tone: "bad", text: "Admission: policy failed (exit 1)\r" }]);
  deepStrictEqual(lines[5], [{ tone: "bad", text: "no stamp: error" }]);
  deepStrictEqual(lines[0], [{ tone: "muted", text: "09:58:48 " }, "Deploying shop at main"]);
});

test("a log piped: uncoloured, line by line, the same bytes", () => {
  const printed = (text: string): string =>
    draw({ view: "log", ...about }, text, now)
      .map((line) => `${paint(line, false)}\n`)
      .join("");
  [log, "", "\n", "one\n\n\ntwo\n"].forEach((text) => {
    strictEqual(printed(text), text);
  });
});

test("an answer that is not what the view reads (an older ctl's text) is printed as it came", () => {
  const old = "20261018T095848Z-0f9e8d  success   aaaaaaaaaaaa  push      deploy main\n";
  deepStrictEqual(draw(runs, old, now), [old.trimEnd()]);
  deepStrictEqual(draw(runs, "", now), []);
  deepStrictEqual(draw(runs, '{"app":"shop"}\n', now), ['{"app":"shop"}']);
  deepStrictEqual(draw({ view: "releases", ...about }, "shop runs aaaa (since 20261018T100000Z). Earlier releases:\n  bbbb  20261016T080000Z\n", now), [
    "shop runs aaaa (since 20261018T100000Z). Earlier releases:",
    "  bbbb  20261016T080000Z",
  ]);
});
