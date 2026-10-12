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

export type Step =
  | {
      readonly kind: "run";
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
  | { readonly kind: "confirm"; readonly prompt: string; readonly expect: string }
  | { readonly kind: "note"; readonly text: string };

/** What a command decides to do, as data: run by the interpreter, printed by --dry-run, compared by tests. */
export type Plan = readonly Step[];

export const run = (argv: readonly [string, ...Arg[]], env: Env = {}): Step => ({
  kind: "run",
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

const describe = (step: Step): string => {
  switch (step.kind) {
    case "run":
      return `run      ${assignments(step.env)}${step.argv.map(arg).join(" ")}${step.stdout === "discard" ? " >/dev/null" : ""}`;
    case "check":
      return `${step.onFailure === "stop" ? "guard   " : "check   "} ${step.label}: ${describeProbe(step.probe)}`;
    case "confirm":
      return `confirm  ${step.prompt}(${step.expect})`;
    case "note":
      return `note     ${step.text}`;
  }
};

export const render = (plan: Plan): readonly string[] => plan.map(describe);
