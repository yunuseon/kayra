import type { Arg, Argv, Env, Need, Plan, Probe, Step } from "./model.ts";

/** A word as a shell reads it back: bare where it is safe, else single-quoted. */
export const quote = (word: string) => (/^[\w@%+=:,./~-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`);

const shell = (argv: Argv) => argv.map(quote).join(" ");

const assignments = (env: Env = {}) =>
  Object.entries(env)
    .map(([key, value]) => `${key}=${quote(value)} `)
    .join("");

const arg = (value: Arg) => {
  if (typeof value === "string") return quote(value);
  const command = `$(${assignments(value.env)}${shell(value.argv)})`;
  return value.words === "one" ? `"${command}"` : command;
};

const describeProbe = (probe: Probe) =>
  probe.kind === "on-path" ? `command -v ${quote(probe.program)}` : assignments(probe.env) + shell(probe.argv);

/** guard, check, run, confirm or note: what kind of step it is, as --dry-run says. */
export const kindOf = (step: Step) => (step.kind === "check" ? (step.onFailure === "stop" ? "guard" : "check") : step.kind);

/** What it is called while it runs; a confirmation and a note say what they say. */
export const titleOf = (step: Step) => {
  switch (step.kind) {
    case "session":
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

/** What --dry-run says a step will ask for: kayra asks it when the step runs. */
const asks = (needs: readonly Need[] = []) =>
  needs.length === 0
    ? ""
    : `  # asks for ${needs.map((need) => (need.kind === "vault" ? `${need.server}'s vault password` : "sudo's password, unless cached")).join(" and ")}`;

/** The shell command a step runs, or undefined if it runs none. */
export const commandOf = (step: Step) => {
  switch (step.kind) {
    case "session":
    case "run":
      return `${assignments(step.env)}${step.argv.map(arg).join(" ")}${step.stdout === "discard" ? " >/dev/null" : ""}${asks(step.needs)}`;
    case "check":
      return describeProbe(step.probe);
    case "confirm":
    case "note":
      return undefined;
  }
};

const describe = (step: Step) => {
  switch (step.kind) {
    case "session":
    case "run":
      return `${step.kind.padEnd(8)} ${commandOf(step) ?? ""}`;
    case "check":
      return `${kindOf(step).padEnd(8)} ${step.label}: ${commandOf(step) ?? ""}`;
    case "confirm":
      return `confirm  ${step.warning} (${step.expect})`;
    case "note":
      return `note     ${step.text}`;
  }
};

/** The plan as plain lines: --dry-run's output where it is read by a program. */
export const render = (plan: Plan) => Object.freeze(plan.map(describe));
