import type { AppName, ServerName } from "../fleet/brand.ts";

/** A value only known when the step runs: the stdout of a command, as `$(…)` would give it. */
export type Substitution = {
  readonly kind: "substitution";
  readonly argv: Argv;
  readonly words: "one" | "many";
  readonly env?: Env;
};

export type Argv = readonly [string, ...string[]];

export type Arg = string | Substitution;

export type Env = Readonly<Record<string, string>>;

/** A question about the Mac, answered by the interpreter. */
export type Probe =
  | { readonly kind: "on-path"; readonly program: string }
  /** Its stdout is discarded (it may be a secret), its stderr shown on failure. */
  | { readonly kind: "exits-zero"; readonly argv: Argv; readonly env?: Env };

/** A deployer's answer, read whole and drawn for the operator by the client (the command line's clients/cli/views.ts): which drawing, and of what. */
export type DeployerAnswer = { readonly view: "runs" | "releases" | "log"; readonly app: AppName; readonly server: ServerName };

/**
 * What a step needs from the operator before it can run, asked by kayra
 * (on the terminal, or in the client that started it) and never written
 * down: a server's vault password, or sudo's password where sudo has none
 * cached.
 */
export type Need = { readonly kind: "vault"; readonly server: ServerName } | { readonly kind: "sudo" };

/** The kayra commands a longer one is made of, each of which runs its part alone. */
export type Part = "provision" | "setup" | "apps" | "verify" | "hosts";

export type Step = { readonly part?: Part } & (
  | {
      readonly kind: "run" | "session";
      /** What it does, in a few words: what the operator sees while it runs. */
      readonly title: string;
      readonly argv: readonly [string, ...Arg[]];
      /** Added to kayra's own environment. */
      readonly env: Env;
      /** As it comes, dropped, or drawn by a view once the step is done. */
      readonly stdout: "show" | "discard" | DeployerAnswer;
      readonly needs?: readonly Need[];
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

export type RunStep = Extract<Step, { readonly kind: "run" | "session" }>;

export const run = (title: string, argv: readonly [string, ...Arg[]], env: Env = {}): RunStep => ({
  kind: "run",
  title,
  argv,
  env,
  stdout: "show",
});

/** Every step of a plan as part of one kayra command. */
export const partOf = (part: Part, plan: Plan): Plan => plan.map((step) => ({ ...step, part }));

/** A plan with a step that talks with a person: a client without a terminal gives it a pty and the person's keys. */
export const needsTerminal = (plan: Plan): boolean => plan.some((step) => step.kind === "session");
