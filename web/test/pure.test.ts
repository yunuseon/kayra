import { describe, expect, test } from "vitest";
import type { RunEvent, Status } from "../../cli/src/clients/wire/contract.gen.ts";
import { ranked, score } from "../src/fuzzy.ts";
import { health, login, ssh } from "../src/reach.ts";
import { href, parse, type Route } from "../src/router.ts";
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
  };
  test("an on-demand SSH that is off is a warning, not a failure; no login on a server without one", () => {
    expect(ssh(server)).toMatchObject({ text: "off (refused)", tone: "warn" });
    expect(login(server)).toBeUndefined();
    expect(health(server)).toBe("warn");
    expect(health({ ...server, ssh: { port: 22, state: "open", ms: 12, error: null } })).toBe("ok");
    expect(health({ ...server, ssh: { port: 22, state: "pending", ms: null, error: null } })).toBe("waiting");
    expect(health({ ...server, ssh: { port: 22, state: "unknown-host", ms: null, error: "ENOTFOUND" } })).toBe("bad");
  });
});
