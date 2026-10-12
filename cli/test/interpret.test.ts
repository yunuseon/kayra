import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { interpret } from "../src/interpret.ts";
import { run, type Plan } from "../src/plan.ts";

type Said = { readonly passed: boolean; readonly out: readonly string[]; readonly err: readonly string[] };

const interpreted = async (plan: Plan, answer = ""): Promise<Said> => {
  // eslint-disable-next-line functional/prefer-immutable-types -- capturing what the interpreter says
  const said: { out: string[]; err: string[] } = { out: [], err: [] };
  const passed = await interpret(plan, {
    // eslint-disable-next-line functional/immutable-data -- capturing
    out: (line) => said.out.push(line),
    // eslint-disable-next-line functional/immutable-data -- capturing
    err: (line) => said.err.push(line),
    ask: () => Promise.resolve(answer),
  });
  return { passed, ...said };
};

test("a failing run stops the plan", async () => {
  const said = await interpreted([run(["false"]), { kind: "note", text: "never" }]);
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
  deepStrictEqual(said, { passed: false, out: ["FAIL  says no", "    nope", "    → try again", "ok    sh"], err: [] });
});

test("a guard is silent when it passes, says why on stderr when it stops the plan", async () => {
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
    err: ["refused"],
  });
});

test("a query's answer takes its place: one word, or many", async () => {
  const said = await interpreted([
    run([
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
  const said = await interpreted([run(["true", { kind: "query", argv: ["false"], words: "one" }])]);
  deepStrictEqual(said, { passed: false, out: [], err: ["kayra: false failed (exit 1)"] });
});

test("a confirmation ends the plan, without failing it, unless the expected answer is typed", async () => {
  const plan: Plan = [{ kind: "confirm", prompt: "Type it: ", expect: "box" }, { kind: "note", text: "destroyed" }];
  deepStrictEqual(await interpreted(plan, "box"), { passed: true, out: ["destroyed"], err: [] });
  deepStrictEqual(await interpreted(plan, "no"), { passed: true, out: ["Aborted."], err: [] });
});

test("a program that does not exist fails instead of throwing", async () => {
  strictEqual((await interpreted([run(["no-such-tool-here"])])).passed, false);
});
