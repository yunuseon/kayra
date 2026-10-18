import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { appName, serverName } from "../src/brand.ts";
import { interpret } from "../src/interpret.ts";
import { needsTerminal, partOf, run, type Plan } from "../src/plan.ts";
import { explain } from "../src/ui/explain.ts";
import { bad, flat, link, paint, strong, width } from "../src/ui/line.ts";
import { footer, framed, listed, position, reporting, type Event, type Invocation } from "../src/ui/progress.ts";
import { colors, escapes, screen, settle, watch } from "../src/ui/terminal.ts";
import { duration, fit, spread, table, truncate, wrap } from "../src/ui/text.ts";
import { must } from "./support.ts";

const guard = (label: string, code = 0) =>
  ({ kind: "check", label, probe: { kind: "exits-zero", argv: ["sh", "-c", `exit ${String(code)}`] }, onFailure: "stop" }) as const;

const deploy: Plan = [
  ...partOf("setup", [guard("box may be changed"), run("Host layer · platform.yml", ["true"])]),
  ...partOf("apps", [run("Remove apps not in server.yml", ["true"])]),
  { ...run("Verify", ["sh", "-c", "exit 1"]), part: "verify" },
];

const invocation: Invocation = { command: "kayra deploy box", server: "box", about: ["platform on home", "box.test"] };

test("durations read as much as is worth reading", () => {
  deepStrictEqual([40, 9_960, 12_400, 123_000, 3_840_000].map(duration), ["0.0s", "9.9s", "12s", "2m03s", "1h04m"]);
});

test("a line spread over the columns, cut to fit, words wrapped", () => {
  strictEqual(flat(spread(["a"], ["1s"], 10)), "a       1s");
  strictEqual(flat(spread(["abcdefghij"], ["1s"], 10)), "abcdefghij  1s");
  deepStrictEqual(truncate(["ab", bad("cdef")], 4), ["ab", { tone: "bad", text: "c" }, "…"]);
  deepStrictEqual(truncate(["ab"], 4), ["ab"]);
  deepStrictEqual(wrap(["aa", "bb", "cc", "averylongword"], 5), ["aa bb", "cc", "averylongword"]);
  strictEqual(width(["✓ ", strong("é")]), 3);
});

test("colors: FORCE_COLOR wins, then NO_COLOR, then a terminal that is not dumb", () => {
  strictEqual(colors(false, { FORCE_COLOR: "0" }), true);
  strictEqual(colors(true, { NO_COLOR: "1" }), false);
  strictEqual(colors(true, { NODE_DISABLE_COLORS: "" }), false);
  strictEqual(colors(true, { TERM: "dumb" }), false);
  strictEqual(colors(true, {}), true);
  strictEqual(colors(false, {}), false);
  strictEqual(paint([bad("x")], false), "x");
  strictEqual(paint([bad("x")], true), "\u001b[31mx\u001b[39m");
});

test("a screen: live only on a terminal outside CI; notifications and progress only where they are understood", () => {
  const iterm = screen({ isTTY: true, columns: 120 }, { TERM_PROGRAM: "iTerm.app" });
  deepStrictEqual(iterm, { colors: true, live: true, columns: 120, title: true, notifications: true, progressBar: false, links: true });
  strictEqual(screen({ isTTY: true }, { TERM_PROGRAM: "vscode" }).links, true);
  strictEqual(screen({ isTTY: true }, { TERM_PROGRAM: "Apple_Terminal" }).links, false);
  strictEqual(screen({ isTTY: true }, { TERM_PROGRAM: "ghostty" }).progressBar, true);
  strictEqual(screen({ isTTY: true }, { TERM_PROGRAM: "iTerm.app", TMUX: "/tmp/tmux" }).notifications, false);
  strictEqual(screen({ isTTY: true }, { CI: "true" }).live, false);
  deepStrictEqual(screen({}, { COLUMNS: "90" }), {
    colors: false,
    live: false,
    columns: 90,
    title: false,
    notifications: false,
    progressBar: false,
    links: false,
  });
  strictEqual(screen({ isTTY: true, columns: 0 }, {}).columns, 80);
  strictEqual(escapes.title("a\u001b]b\u0007c"), "\u001b]0;a ]b c\u0007");
});

test("a link opens its URL where the terminal makes links, and is its text elsewhere", () => {
  const domain = [link("shop.example", "https://shop.example/", "bad")];
  strictEqual(paint(domain, false), "shop.example");
  strictEqual(paint(domain, false, true), "\u001b]8;;https://shop.example/\u0007shop.example\u001b]8;;\u0007");
  strictEqual(paint(domain, true, true), "\u001b]8;;https://shop.example/\u0007\u001b[31mshop.example\u001b[39m\u001b]8;;\u0007");
  deepStrictEqual(truncate(domain, 5), [{ text: "shop", href: "https://shop.example/", tone: "bad" }, "…"]);
});

test("a table: columns as wide as their widest cell, nothing after a row's last; cut to fit, the named columns first", () => {
  const rows = [[["NAME"], ["DOMAIN"], ["APPS"]], [["edge"], ["yunusozturk.de"], []], [["alaz"], ["alaz.home.example"], ["sudoku, wiki"]]];
  deepStrictEqual(table(rows).map(flat), ["NAME  DOMAIN             APPS", "edge  yunusozturk.de", "alaz  alaz.home.example  sudoku, wiki"]);
  deepStrictEqual(table(fit(rows, 30, [2, 1])).map(flat), ["NAME  DOMAIN             APPS", "edge  yunusozturk.de", "alaz  alaz.home.example  sudo…"]);
  deepStrictEqual(table(fit(rows, 20, [2, 1])).map(flat), ["NAME  DOMAIN    APPS", "edge  yunusoz…", "alaz  alaz.ho…  sud…"]);
});

test("watch: a block drawn in place until every answer is in, then cleared; settle: the same state, drawn nowhere", async () => {
  // eslint-disable-next-line functional/prefer-immutable-types -- capturing what is written
  const written: string[] = [];
  const later = (ms: number, value: string): Promise<(state: readonly string[]) => readonly string[]> =>
    new Promise((resolve) => {
      setTimeout(() => {
        resolve((state) => [...state, value]);
      }, ms);
    });
  const updates = [later(30, "a"), later(130, "b")];
  const state = await watch(
    // eslint-disable-next-line functional/immutable-data -- capturing
    (raw) => written.push(raw),
    [],
    updates,
    (so, frame) => [`${frame} ${String(so.length)}`, so.join(",")],
  );
  deepStrictEqual(state, ["a", "b"]);
  deepStrictEqual(await settle([], updates), ["a", "b"]);
  const drawn = written.join("");
  strictEqual(drawn.startsWith(`${escapes.clearLine}⠋ 0\n${escapes.clearLine}\n`), true);
  strictEqual(drawn.includes(`${escapes.up(2)}${escapes.clearLine}`), true);
  strictEqual(drawn.includes(" 1\n"), true);
  strictEqual(drawn.endsWith(`a,b\n${escapes.clearDown}${escapes.up(2)}${escapes.clearDown}`), true);
});

test("a step opens a part only in a plan of several", () => {
  deepStrictEqual(
    deploy.map((_, index) => position(deploy, index).opens),
    ["setup", undefined, "apps", "verify"],
  );
  strictEqual(position(partOf("setup", [guard("a")]), 0).opens, undefined);
});

test("the footer: how it went, and for a failed part the command that reruns it alone", () => {
  const verify = deploy[3];
  if (verify === undefined) throw new Error("no verify step");
  deepStrictEqual(footer(invocation, deploy, { failures: 0 }, 2_000).map(flat), ["✓ kayra deploy box · 4 steps · 2.0s"]);
  deepStrictEqual(footer(invocation, deploy, { failures: 1, stop: { index: 3, step: verify, why: "failed" } }, 65_000).map(flat), [
    "✗ kayra deploy box failed at Verify · step 4 of 4 · 1m05s",
    "  → kayra verify box runs just this part",
  ]);
  deepStrictEqual(footer({ ...invocation, command: "kayra doctor" }, [guard("a"), guard("b")], { failures: 1 }, 100).map(flat), [
    "✗ kayra doctor · 1 of 2 checks failed · 0.1s",
  ]);
  deepStrictEqual(footer(invocation, deploy, { failures: 0, stop: { index: 0, step: guard("a"), why: "declined" } }, 0).map(flat), [
    "■ kayra deploy box stopped at step 1 of 4: not confirmed",
  ]);
  deepStrictEqual(footer(invocation, deploy, { failures: 0, stop: { index: 1, step: guard("a"), why: "interrupted" } }, 0).map(flat), [
    "■ kayra deploy box interrupted at step 2 of 4 · 0.0s",
  ]);
});

test("framed: a heading, each part and step with its time, a footer; nothing a terminal would redraw when it is not one", async () => {
  // eslint-disable-next-line functional/prefer-immutable-types -- capturing what is written
  const written: string[] = [];
  const quiet = screen({}, {});
  const silentIo = { out: () => undefined, err: () => undefined, ask: () => Promise.resolve("") };
  const progress = framed(
    quiet,
    // eslint-disable-next-line functional/immutable-data -- capturing
    (raw) => written.push(raw),
    invocation,
  );
  strictEqual(await interpret(deploy, silentIo, progress), false);
  const lines = written.join("").replace(/ +\S*\d\.?\d*s$/gm, " <time>").split("\n");
  deepStrictEqual(lines, [
    "kayra deploy box · platform on home · box.test · 4 steps",
    "",
    "setup",
    "  ✓ box may be changed <time>",
    "  ◆ Host layer · platform.yml                                                2/4",
    "  ✓ Host layer · platform.yml <time>",
    "",
    "apps",
    "  ◆ Remove apps not in server.yml                                            3/4",
    "  ✓ Remove apps not in server.yml <time>",
    "",
    "verify",
    "  ◆ Verify                                                                   4/4",
    "  ✗ Verify                                                         exit 1 · <time>",
    "",
    "✗ kayra deploy box failed at Verify · step 4 of 4 · <time>",
    "  → kayra verify box runs just this part",
    "",
  ]);
});

test("--dry-run on a terminal: numbered steps under their parts, each command below its title, paths by their root", () => {
  const plan: Plan = [
    ...partOf("setup", [run("Ansible collections", ["ansible-galaxy", "install", "-r", "/kayra/ansible/requirements.yml"])]),
    ...partOf("apps", [{ kind: "confirm", warning: "This destroys box.", expect: "box" }]),
  ];
  deepStrictEqual(
    explain(invocation, plan, (text) => text.replaceAll("/kayra", "<kayra>"), 80).map(flat),
    [
      "kayra deploy box · platform on home · box.test · 2 steps · dry run: nothing runs",
      "",
      "setup",
      "  1  run      Ansible collections",
      "              ansible-galaxy install -r <kayra>/ansible/requirements.yml",
      "",
      "apps",
      "  2  confirm  This destroys box.",
      "              asks for 'box' to be typed, or stops",
    ],
  );
});

test("--dry-run says how a drawn answer is shown, below its command", () => {
  const plan: Plan = [{ ...run("Runs of shop", ["ssh", "box", "ctl", "runs", "shop", "--json"]), stdout: { view: "runs", app: must(appName("shop")), server: must(serverName("box")) } }];
  deepStrictEqual(explain(invocation, plan, (text) => text, 80).map(flat).slice(2), [
    "  1  run      Runs of shop",
    "              ssh box ctl runs shop --json",
    "              → its answer drawn as a table of runs",
  ]);
});

test("reporting: the plan, each step started and done, then how it ended, as events", async () => {
  // eslint-disable-next-line functional/prefer-immutable-types -- capturing what is emitted
  const events: Event[] = [];
  const silentIo = { out: () => undefined, err: () => undefined, ask: () => Promise.resolve("") };
  // eslint-disable-next-line functional/immutable-data -- capturing
  strictEqual(await interpret(deploy, silentIo, reporting((event) => events.push(event), invocation, (text) => text)), false);
  deepStrictEqual(
    events.map((event) => (event.kind === "plan" ? `plan ${String(event.steps.length)}` : event.kind === "ended" ? `ended ${event.stop?.why ?? ""}` : `${event.kind} ${String(event.index)}`)),
    ["plan 4", "started 0", "done 0", "started 1", "done 1", "started 2", "done 2", "started 3", "done 3", "ended failed"],
  );
  const ended = events.at(-1);
  strictEqual(ended?.kind === "ended" ? flat(ended.footer[1] ?? []) : "", "  → kayra verify box runs just this part");
});

test("listed: each step's kind, title, command with its paths named by their root, and the part it opens", () => {
  deepStrictEqual(listed(deploy.slice(0, 3), (text) => text.replaceAll("/kayra", "<kayra>")), [
    { index: 0, kind: "guard", title: "box may be changed", command: "sh -c 'exit 0'", part: "setup", opens: "setup" },
    { index: 1, kind: "run", title: "Host layer · platform.yml", command: "true", part: "setup" },
    { index: 2, kind: "run", title: "Remove apps not in server.yml", command: "true", part: "apps", opens: "apps" },
  ]);
  strictEqual(needsTerminal(deploy), false);
  strictEqual(needsTerminal([run("asks", ["ansible-playbook"], { ANSIBLE_ASK_VAULT_PASS: "True" })]), true);
});
