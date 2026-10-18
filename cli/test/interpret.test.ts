import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { interpret } from "../src/interpret.ts";
import { run, type Plan } from "../src/plan.ts";
import { appName, serverName } from "../src/brand.ts";
import { flat } from "../src/ui/line.ts";
import { must } from "./support.ts";

type Said = { readonly passed: boolean; readonly out: readonly string[]; readonly err: readonly string[] };

const interpreted = async (plan: Plan, answer = "", interrupted = false): Promise<Said> => {
  // eslint-disable-next-line functional/prefer-immutable-types -- capturing what the interpreter says
  const said: { out: string[]; err: string[] } = { out: [], err: [] };
  const passed = await interpret(
    plan,
    {
      // eslint-disable-next-line functional/immutable-data -- capturing
      out: (text) => said.out.push(flat(text)),
      // eslint-disable-next-line functional/immutable-data -- capturing
      err: (text) => said.err.push(flat(text)),
      ask: () => Promise.resolve(answer),
    },
    undefined,
    () => interrupted,
  );
  return { passed, ...said };
};

test("a failing run stops the plan", async () => {
  const said = await interpreted([run("fails", ["false"]), { kind: "note", text: "never" }]);
  deepStrictEqual(said, { passed: false, out: [], err: [] });
});

test("a diagnosis reports its failure with stderr and hint, and the plan goes on", async () => {
  const said = await interpreted([
    {
      kind: "check",
      label: "says no",
      probe: { kind: "exits-zero", argv: ["sh", "-c", "echo secret; echo nope >&2; exit 3"] },
      hint: "try again",
      onFailure: "continue",
    },
    { kind: "check", label: "sh", probe: { kind: "on-path", program: "sh" }, onFailure: "continue" },
  ]);
  deepStrictEqual(said, { passed: false, out: ["✗ says no", "    nope", "    → try again", "✓ sh"], err: [] });
});

test("a guard says nothing when it passes, why on stderr when it stops the plan", async () => {
  const guard = (code: number) =>
    ({
      kind: "check",
      label: "guard",
      probe: { kind: "exits-zero", argv: ["sh", "-c", `echo refused >&2; exit ${String(code)}`] },
      onFailure: "stop",
    }) as const;
  deepStrictEqual(await interpreted([guard(0), { kind: "note", text: "went on" }]), {
    passed: true,
    out: ["went on"],
    err: [],
  });
  deepStrictEqual(await interpreted([guard(1), { kind: "note", text: "never" }]), {
    passed: false,
    out: [],
    err: ["    refused"],
  });
});

test("a query's answer takes its place: one word, or many", async () => {
  const said = await interpreted([
    run("queries", [
      "sh",
      "-c",
      'test "$1" = "a b" && test "$2" = c && test "$3" = d',
      "sh",
      { kind: "query", argv: ["echo", "a b"], words: "one" },
      { kind: "query", argv: ["printf", "c\\n d\\n"], words: "many" },
    ]),
  ]);
  strictEqual(said.passed, true);
});

test("a failing query stops the plan before its step runs", async () => {
  const said = await interpreted([run("never", ["true", { kind: "query", argv: ["false"], words: "one" }])]);
  deepStrictEqual(said, { passed: false, out: [], err: ["    $(false) failed: exit 1"] });
});

test("a quiet step's stderr comes after it, so it cannot tear through a spinner", async () => {
  const quiet: Plan = [{ ...run("quiet", ["sh", "-c", "echo hidden; echo said >&2"]), stdout: "discard" }];
  deepStrictEqual(await interpreted(quiet), { passed: true, out: [], err: ["    said"] });
});

test("a confirmation ends the plan, without failing it, unless the expected answer is typed", async () => {
  const plan: Plan = [{ kind: "confirm", warning: "This destroys box.", expect: "box" }, { kind: "note", text: "destroyed" }];
  deepStrictEqual(await interpreted(plan, "box"), { passed: true, out: ["destroyed"], err: ["", "  ▲ This destroys box."] });
  deepStrictEqual(await interpreted(plan, "no"), { passed: true, out: ["Aborted."], err: ["", "  ▲ This destroys box."] });
});

test("an interrupted plan stops after the step that was running, and does not pass", async () => {
  deepStrictEqual(await interpreted([run("ok", ["true"]), { kind: "note", text: "never" }], "", true), {
    passed: false,
    out: [],
    err: [],
  });
});

test("a program that does not exist fails instead of throwing, and says so", async () => {
  const said = await interpreted([run("missing", ["no-such-tool-here"])]);
  strictEqual(said.passed, false);
  strictEqual(said.err.at(0)?.startsWith("    no-such-tool-here: spawn no-such-tool-here ENOENT"), true);
});

const forge = { app: must(appName("shop")), server: must(serverName("forge")) };

test("a drawn step's answer is read whole and drawn once it is done, even when it failed", async () => {
  const drawn = { ...run("Log", ["sh", "-c", "printf '09:00:00 fine\\n09:00:01 it failed\\n'; exit 2"]), stdout: { view: "log", ...forge } } as const;
  deepStrictEqual(await interpreted([drawn]), { passed: false, out: ["09:00:00 fine", "09:00:01 it failed"], err: [] });
  const old = { ...run("Runs", ["printf", "an older ctl's text\\n"]), stdout: { view: "runs", ...forge } } as const;
  deepStrictEqual(await interpreted([old]), { passed: true, out: ["an older ctl's text"], err: [] });
});

// eslint-disable-next-line functional/prefer-immutable-types -- a real AbortSignal, a class the rule cannot see into
const piped = async (plan: Plan, signal?: AbortSignal) => {
  // eslint-disable-next-line functional/prefer-immutable-types -- capturing what the interpreter says
  const chunks: string[] = [];
  const passed = await interpret(
    plan,
    {
      out: () => undefined,
      err: () => undefined,
      ask: () => Promise.resolve(""),
      // eslint-disable-next-line functional/immutable-data -- capturing
      output: (chunk, stream) => chunks.push(`${stream}:${chunk}`),
      ...(signal === undefined ? {} : { signal }),
    },
    undefined,
    () => signal?.aborted === true,
  );
  return { passed, chunks };
};

test("without a terminal, what a step shows reaches the sink, and no step reads stdin", async () => {
  const said = await piped([run("both", ["sh", "-c", "echo out; echo err >&2"]), run("reads stdin", ["cat"])]);
  strictEqual(said.passed, true);
  deepStrictEqual(said.chunks.toSorted(), ["stderr:err\n", "stdout:out\n"]);
});

test("an abort stops the running step's program and the plan, quickly", async () => {
  const stop = new AbortController();
  setTimeout(() => {
    stop.abort();
  }, 200);
  const started = performance.now();
  const said = await piped([run("waits", ["sleep", "30"]), run("never", ["sh", "-c", "echo never"])], stop.signal);
  strictEqual(said.passed, false);
  deepStrictEqual(said.chunks, []);
  strictEqual(performance.now() - started < 5_000, true);
});
