import { describe, expect, test } from "vitest";
import type { RunEvent, RunState, RunSummary, ServerFacts, Status } from "../../cli/src/clients/wire/contract.gen.ts";
import { ranked, score } from "../src/fuzzy.ts";
import { attention, newest, primary, strip, stripLabel } from "../src/overview.ts";
import { bracket, health, kayra, login, ssh, verdict } from "../src/reach.ts";
import { href, parse, trail, type Route } from "../src/router.ts";
import { initialTheme } from "../src/theme.ts";
import { empty, outcome, reduce } from "../src/run.ts";
import { styled } from "../src/sgr.ts";

describe("routes", () => {
  test("every page has a URL that parses back to it", () => {
    const routes: readonly Route[] = [
      { page: "fleet" },
      { page: "server", server: "alaz" },
      { page: "app", server: "alaz", app: "shop" },
      { page: "runs" },
      { page: "run", id: "20261018T201502Z-a1b2c3" },
      { page: "session", id: "20261018T201502Z-a1b2c3" },
      { page: "validate" },
    ];
    routes.forEach((route) => {
      expect(parse(href(route))).toEqual(route);
    });
  });
  test("anything else is missing, never a guess", () => {
    expect(parse("/servers/alaz/apps")).toEqual({ page: "missing", path: "/servers/alaz/apps" });
    expect(parse("/servers/%3Cscript%3E")).toEqual({ page: "missing", path: "/servers/%3Cscript%3E" });
  });
});

describe("colour codes", () => {
  test("SGR becomes classes; every other escape is dropped", () => {
    expect(styled("\u001b[0;33mchanged\u001b[0m ok\u001b[2K")).toEqual([
      { text: "changed", classes: "sgr-yellow" },
      { text: " ok", classes: "" },
    ]);
    expect(styled("\u001b[1;31mfatal\u001b[22m!\u001b[39m")).toEqual([
      { text: "fatal", classes: "sgr-red sgr-bold" },
      { text: "!", classes: "sgr-red" },
    ]);
    expect(styled("\u001b[38;5;208morange\u001b[0m\u001b]0;title\u0007")).toEqual([{ text: "orange", classes: "" }]);
    expect(styled("plain")).toEqual([{ text: "plain", classes: "" }]);
  });
});

describe("a run, folded", () => {
  const plan: RunEvent = {
    kind: "plan",
    invocation: { command: "kayra deploy lab", server: "lab", about: [] },
    steps: [
      { index: 0, kind: "guard", title: "lab may be changed", part: "setup", opens: "setup" },
      { index: 1, kind: "run", title: "Host layer", part: "setup" },
      { index: 2, kind: "run", title: "Verify", part: "verify", opens: "verify" },
    ],
  };
  const events: readonly RunEvent[] = [
    plan,
    { kind: "started", index: 0 },
    { kind: "done", index: 0, failed: false, stopped: false, ms: 300 },
    { kind: "started", index: 1 },
    { kind: "output", stream: "stdout", chunk: "~ traefik › config\n" },
    { kind: "done", index: 1, failed: true, stopped: true, why: "exit 2", ms: 9000 },
    { kind: "said", stream: "err", text: "    it failed" },
    { kind: "ended", failures: 1, stop: { index: 1, why: "failed" }, ms: 9400, footer: [] },
  ];
  test("each step's state, time and what it printed; the steps after a failure never ran", () => {
    const view = events.reduce((so, event) => reduce(so, event, 1_000), empty);
    expect(view.steps.map((step) => step.state)).toEqual(["passed", "failed", "skipped"]);
    expect(view.steps[1]?.said).toEqual([
      { kind: "output", stream: "stdout", chunk: "~ traefik › config\n" },
      { kind: "said", stream: "err", text: "    it failed" },
    ]);
    expect(view.steps[1]?.why).toBe("exit 2");
    expect(outcome(view)).toBe("failed");
  });
  test("a confirmation asked, then answered; a run cut short is interrupted", () => {
    const asking = reduce(reduce(empty, plan, 0), { kind: "ask", secret: false, prompt: "Type lab" }, 0);
    expect(asking.asking?.prompt).toBe("Type lab");
    expect(reduce(asking, { kind: "answered" }, 0).asking).toBeUndefined();
    const cut = [
      plan,
      { kind: "started", index: 0 } as const,
      { kind: "done", index: 0, failed: true, stopped: true, why: "exit 99", ms: 5 } as const,
      { kind: "ended", failures: 0, stop: { index: 0, why: "interrupted" }, ms: 5, footer: [] } as const,
    ].reduce(
      (so: typeof empty, event: RunEvent) => reduce(so, event, 0),
      empty,
    );
    expect(cut.steps.map((step) => step.state)).toEqual(["stopped", "skipped", "skipped"]);
    expect(outcome(cut)).toBe("interrupted");
  });
});

describe("the palette's matching", () => {
  test("letters in order, the tighter and earlier the better", () => {
    expect(score("deploy alaz", "dal")).toBeDefined();
    expect(score("deploy alaz", "zz")).toBeUndefined();
    const choices = [
      { label: "setup alaz", hint: "run" },
      { label: "deploy alaz", hint: "run" },
      { label: "alaz", hint: "platform on home" },
    ];
    expect(ranked(choices, "alaz").at(0)?.label).toBe("alaz");
    expect(ranked(choices, "dep").map((choice) => choice.label)).toEqual(["deploy alaz"]);
    expect(ranked(choices, "")).toEqual(choices);
  });
});

describe("status cells", () => {
  const server: Status["servers"][number] = {
    name: "nas",
    kind: "nas",
    target: "home",
    domain: "example.com",
    apps: [],
    machine: { state: "found", address: "192.0.2.4", from: "inventory", reason: null },
    ssh: { port: 22, state: "refused", ms: null, error: null },
    https: null,
    kayra: { pin: "0.19.0", state: "skipped", version: null, error: null },
  };
  test("an on-demand SSH that is off is a warning, not a failure; no login on a server without one", () => {
    expect(ssh(server)).toMatchObject({ text: "off (refused)", tone: "warn" });
    expect(login(server)).toBeUndefined();
    expect(health(server)).toBe("warn");
    expect(health({ ...server, ssh: { port: 22, state: "open", ms: 12, error: null } })).toBe("ok");
    expect(health({ ...server, ssh: { port: 22, state: "pending", ms: null, error: null } })).toBe("waiting");
    expect(health({ ...server, ssh: { port: 22, state: "unknown-host", ms: null, error: "ENOTFOUND" } })).toBe("bad");
  });
  test("the kayra that set it up: the pin is fine, anything else a warning naming the pin, which leaves its health alone", () => {
    const open = { ...server, ssh: { port: 22, state: "open" as const, ms: 12, error: null } };
    expect(kayra({ ...open, kayra: { ...open.kayra, state: "recorded", version: "0.19.0" } })).toMatchObject({ text: "0.19.0", tone: "ok" });
    const behind = { ...open, kayra: { ...open.kayra, state: "recorded" as const, version: "0.18.0" } };
    expect(kayra(behind)).toMatchObject({ text: "0.18.0 → 0.19.0", tone: "warn" });
    expect(kayra({ ...open, kayra: { ...open.kayra, state: "unrecorded" } })).toMatchObject({ text: "unrecorded → 0.19.0", tone: "warn" });
    expect(kayra(server)).toMatchObject({ text: "not asked", tone: "muted" });
    expect(health(behind)).toBe("ok");
  });
  test("a verdict is one bracketed word: behind the pin only when nothing else is wrong", () => {
    const open = { ...server, ssh: { port: 22, state: "open" as const, ms: 12, error: null } };
    const behind = { ...open, kayra: { ...open.kayra, state: "recorded" as const, version: "0.18.0" } };
    expect(verdict(undefined)).toEqual({ word: "ASKING", tone: "waiting" });
    expect(verdict(open)).toEqual({ word: "OK", tone: "ok" });
    expect(verdict(behind)).toEqual({ word: "BEHIND", tone: "warn" });
    expect(verdict({ ...behind, ssh: { port: 22, state: "refused", ms: null, error: null } })).toEqual({ word: "WARN", tone: "warn" });
    expect(verdict({ ...behind, ssh: { port: 22, state: "unreachable", ms: null, error: null } })).toEqual({ word: "FAIL", tone: "bad" });
    expect(bracket("OK")).toBe("[  OK  ]");
    expect(bracket("FAIL")).toBe("[ FAIL ]");
    expect(bracket("RUN")).toBe("[ RUN  ]");
    expect(bracket("BEHIND")).toBe("[BEHIND]");
    expect(bracket("DECLINED")).toBe("[DECLINED]");
  });
});

describe("the overview", () => {
  const facts = (name: string, kind: ServerFacts["kind"], commands: ServerFacts["commands"]): ServerFacts => ({ name, kind, target: "home", domain: `${name}.example.com`, apps: [], commands });
  const run = (id: string, server: string, state: RunState): RunSummary => ({ id, command: `kayra deploy ${server}`, server, started: `2026-10-${id}T10:00:00Z`, state, session: false });
  const reached = (name: string, change: Partial<Status["servers"][number]>): Status["servers"][number] => ({
    name,
    kind: "platform",
    target: "home",
    domain: `${name}.example.com`,
    apps: [],
    machine: { state: "found", address: "192.0.2.4", from: "inventory", reason: null },
    ssh: { port: 22, state: "open", ms: 3, error: null },
    https: null,
    kayra: { pin: "0.19.0", state: "recorded", version: "0.19.0", error: null },
    ...change,
  });

  test("a theme stored by the toggle wins; without one, the system's", () => {
    expect(initialTheme("light", true)).toBe("light");
    expect(initialTheme("dark", false)).toBe("dark");
    expect(initialTheme(null, true)).toBe("dark");
    expect(initialTheme("sepia", false)).toBe("light");
  });

  test("a breadcrumb links each step back, the page itself last", () => {
    expect(trail({ page: "fleet" })).toEqual([{ label: "overview" }]);
    expect(trail({ page: "app", server: "alaz", app: "shop" })).toEqual([
      { label: "servers", to: { page: "fleet" } },
      { label: "alaz", to: { page: "server", server: "alaz" } },
      { label: "shop" },
    ]);
    expect(trail({ page: "run", id: "20261018T201502Z-a1b2c3" })).toEqual([{ label: "runs", to: { page: "runs" } }, { label: "a1b2c3" }]);
  });

  test("a server's strip is its latest runs, oldest first, said in words too", () => {
    const runs = [run("03", "alaz", "failed"), run("01", "alaz", "passed"), run("02", "edge", "passed"), run("04", "alaz", "running")];
    expect(newest(runs).map((each) => each.id)).toEqual(["04", "03", "02", "01"]);
    expect(strip(runs, "alaz", 2)).toEqual(["failed", "running"]);
    expect(strip(runs, "alaz", 16)).toEqual(["passed", "failed", "running"]);
    expect(stripLabel(strip(runs, "alaz", 16))).toBe("Last 3 runs: 1 passed, 1 failed, 1 running");
    expect(stripLabel([])).toBe("No runs from here yet");
  });

  test("the command that records the pin: deploy on a platform, setup elsewhere, none where neither is offered", () => {
    expect(primary(facts("alaz", "platform", ["deploy", "setup", "plan"]))).toBe("deploy");
    expect(primary(facts("nas", "nas", ["setup", "plan"]))).toBe("setup");
    expect(primary(facts("box", "edge", ["plan"]))).toBeUndefined();
  });

  test("what needs the operator comes worst first, each with what to do about it", () => {
    const servers = [facts("alaz", "platform", ["deploy", "setup"]), facts("nas", "nas", ["setup"]), facts("edge", "edge", ["setup"])];
    const seen = [
      reached("alaz", { kayra: { pin: "0.19.0", state: "recorded", version: "0.18.0", error: null } }),
      reached("nas", { ssh: { port: 22, state: "refused", ms: null, error: null } }),
      reached("edge", { ssh: { port: 22, state: "unreachable", ms: null, error: "EHOSTUNREACH" } }),
    ];
    const runs = [run("01", "alaz", "passed"), run("02", "alaz", "failed"), run("03", "edge", "running")];
    const notes = attention(servers, seen, runs);
    expect(notes.map((note) => `${note.tone}: ${note.title}`)).toEqual([
      "bad: edge does not answer",
      "bad: kayra deploy alaz failed",
      "warn: alaz runs kayra 0.18.0",
      "warn: nas: SSH is off",
      "active: running: kayra deploy edge",
    ]);
    expect(notes[0]?.text).toBe("ssh unreachable");
    expect(notes[2]?.remedies[0]).toEqual({ kind: "run", label: "deploy alaz", draft: { name: "deploy", input: { server: "alaz" } } });
    expect(attention(servers, [reached("alaz", {}), reached("nas", {}), reached("edge", {})], [run("01", "alaz", "failed"), run("02", "alaz", "passed")])).toEqual([]);
  });
});
