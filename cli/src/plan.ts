/** A value only known when the step runs: the stdout of a command, as `$(…)` would give it. */
export type Query = {
  readonly kind: "query";
  readonly argv: Argv;
  readonly words: "one" | "many";
  readonly env?: Env;
};

export type Argv = readonly [string, ...string[]];
export type Arg = string | Query;
export type Env = Readonly<Record<string, string>>;

/** A question about the Mac, answered by the interpreter. */
export type Probe =
  | { readonly kind: "on-path"; readonly program: string }
  /** Its stdout is discarded (it may be a secret), its stderr shown on failure. */
  | { readonly kind: "exits-zero"; readonly argv: Argv; readonly env?: Env };

/** The kayra commands a longer one is made of, each of which runs its part alone. */
export type Part = "provision" | "setup" | "apps" | "verify" | "hosts";

export type Step = { readonly part?: Part } & (
  | {
      readonly kind: "run";
      /** What it does, in a few words: what the operator sees while it runs. */
      readonly title: string;
      readonly argv: readonly [string, ...Arg[]];
      /** Added to kayra's own environment. */
      readonly env: Env;
      readonly stdout: "show" | "discard";
    }
  | {
      readonly kind: "check";
      readonly label: string;
      readonly probe: Probe;
      readonly hint?: string;
      /** A guard stops the plan, silent unless it fails; a diagnosis (doctor) reports and goes on. */
      readonly onFailure: "stop" | "continue";
    }
  /** Ends the plan, without failing it, unless the operator types `expect`. */
  | { readonly kind: "confirm"; readonly warning: string; readonly expect: string }
  | { readonly kind: "note"; readonly text: string }
);

/** What a command decides to do, as data: run by the interpreter, printed by --dry-run, compared by tests. */
export type Plan = readonly Step[];

export type RunStep = Extract<Step, { readonly kind: "run" }>;

export const run = (title: string, argv: readonly [string, ...Arg[]], env: Env = {}): RunStep => ({
  kind: "run",
  title,
  argv,
  env,
  stdout: "show",
});

const quote = (word: string): string => (/^[\w@%+=:,./~-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

export const shell = (argv: Argv): string => argv.map(quote).join(" ");

const assignments = (env: Env = {}): string =>
  Object.entries(env)
    .map(([key, value]) => `${key}=${quote(value)} `)
    .join("");

const arg = (value: Arg): string => {
  if (typeof value === "string") return quote(value);
  const command = `$(${assignments(value.env)}${shell(value.argv)})`;
  return value.words === "one" ? `"${command}"` : command;
};

const describeProbe = (probe: Probe): string =>
  probe.kind === "on-path" ? `command -v ${quote(probe.program)}` : assignments(probe.env) + shell(probe.argv);

/** Every step of a plan as part of one kayra command. */
export const partOf = (part: Part, plan: Plan): Plan => plan.map((step) => ({ ...step, part }));

/** guard, check, run, confirm or note: what kind of step it is, as --dry-run says. */
export const kindOf = (step: Step): string => (step.kind === "check" ? (step.onFailure === "stop" ? "guard" : "check") : step.kind);

/** What it is called while it runs; a confirmation and a note say what they say. */
export const titleOf = (step: Step): string => {
  switch (step.kind) {
    case "run":
      return step.title;
    case "check":
      return step.label;
    case "confirm":
      return step.warning;
    case "note":
      return step.text;
  }
};

/** The shell command a step runs, or undefined if it runs none. */
export const commandOf = (step: Step): string | undefined => {
  switch (step.kind) {
    case "run":
      return `${assignments(step.env)}${step.argv.map(arg).join(" ")}${step.stdout === "discard" ? " >/dev/null" : ""}`;
    case "check":
      return describeProbe(step.probe);
    case "confirm":
    case "note":
      return undefined;
  }
};

const describe = (step: Step): string => {
  switch (step.kind) {
    case "run":
      return `run      ${commandOf(step) ?? ""}`;
    case "check":
      return `${kindOf(step).padEnd(8)} ${step.label}: ${commandOf(step) ?? ""}`;
    case "confirm":
      return `confirm  ${step.warning} (${step.expect})`;
    case "note":
      return `note     ${step.text}`;
  }
};

/** The plan as plain lines: --dry-run's output where it is read by a program. */
export const render = (plan: Plan): readonly string[] => plan.map(describe);
