/**
 * What kayra ui's server and the browser say to each other. Standalone: web/
 * imports these types and nothing else of the CLI. The server assigns its own
 * values to them, so a change on either side that breaks the other does not
 * compile.
 */

export type Tone = "ok" | "bad" | "warn" | "active" | "muted" | "strong" | "accent";
export type Span = string | { readonly tone?: Tone; readonly text: string; readonly href?: string };
export type Line = readonly Span[];
export type Text = string | Line;

export type Part = "provision" | "setup" | "apps" | "verify" | "hosts";

/** The commands a server's page offers: these and its job. */
export type ServerCommand = "up" | "provision" | "deploy" | "setup" | "plan" | "verify" | "apps" | "down" | "adopt" | "backup test";

/** A command the browser may ask for; the server checks it against the fleet before anything runs. */
export type CommandInput =
  | { readonly name: ServerCommand; readonly server: string }
  | { readonly name: "app deploy"; readonly server: string; readonly app: string; readonly ref?: string }
  | { readonly name: "app rollback"; readonly server: string; readonly app: string; readonly sha: string }
  | { readonly name: "app purge"; readonly server: string; readonly app: string }
  | { readonly name: "job"; readonly server: string; readonly job: "gc" | "renovate"; readonly noPrs: boolean }
  | { readonly name: "doctor" };

export type CommandName = CommandInput["name"];

export type ServerFacts = {
  readonly name: string;
  readonly kind: "platform" | "edge" | "nas";
  readonly target: "multipass" | "hetzner" | "home";
  readonly domain: string;
  readonly apps: readonly string[];
  /** The commands the browser offers for it, in the order it shows them. */
  readonly commands: readonly (ServerCommand | "job")[];
  /** Its secrets ask for the vault password on a terminal: nothing that opens them runs here. */
  readonly needsTerminal: boolean;
};

export type FleetFacts = {
  readonly fleet: string;
  readonly version: string;
  readonly servers: readonly ServerFacts[];
};

/** How a port answered from the Mac; `pending` until it has. */
export type ReachState = "pending" | "open" | "answered" | "refused" | "no-answer" | "unreachable" | "unknown-host" | "bad-certificate" | "failed" | "skipped";

/** `kayra status --json`. */
export type Status = {
  readonly servers: readonly {
    readonly name: string;
    readonly kind: string;
    readonly target: string;
    readonly domain: string;
    readonly apps: readonly string[];
    readonly machine: {
      readonly state: "pending" | "found" | "not-provisioned" | "no-machine" | "unreadable";
      readonly address: string | null;
      readonly from: "inventory" | "opentofu" | null;
      readonly reason: string | null;
    };
    readonly ssh: { readonly port: number; readonly state: ReachState; readonly ms: number | null; readonly error: string | null };
    readonly https: {
      readonly url: string;
      readonly state: ReachState;
      readonly status: number | null;
      readonly ms: number | null;
      readonly error: string | null;
    } | null;
  }[];
};

/** `kayra validate --json`. */
export type Validation = {
  readonly result: "problem" | "unchecked" | "passed";
  readonly servers: readonly {
    readonly name: string;
    readonly kind: string;
    readonly target: string;
    readonly result: "problem" | "unchecked" | "passed";
    readonly findings: readonly { readonly result: "problem" | "unchecked" | "passed"; readonly text: string; readonly hint: string | null }[];
  }[];
};

/** A step as listed before it runs. */
export type Listed = {
  readonly index: number;
  readonly kind: string;
  readonly title: string;
  readonly command?: string;
  readonly part?: Part;
  readonly opens?: Part;
};

export type Invocation = { readonly command: string; readonly server?: string; readonly about: readonly string[] };

/** What the server answers for a dry run. */
export type Preview = { readonly invocation: Invocation; readonly steps: readonly Listed[]; readonly changes: boolean };

export type Stop = "failed" | "declined" | "interrupted";

/** One thing that happened in a run, in order: replayed in full to a viewer that comes late. */
export type RunEvent =
  | { readonly kind: "plan"; readonly invocation: Invocation; readonly steps: readonly Listed[] }
  | { readonly kind: "started"; readonly index: number }
  | { readonly kind: "done"; readonly index: number; readonly failed: boolean; readonly stopped: boolean; readonly why?: string; readonly ms: number }
  | {
      readonly kind: "ended";
      readonly failures: number;
      readonly stop?: { readonly index: number; readonly why: Stop };
      readonly ms: number;
      readonly footer: readonly Line[];
    }
  /** A program's output, as it came; Ansible's is coloured (SGR). */
  | { readonly kind: "output"; readonly stream: "stdout" | "stderr"; readonly chunk: string }
  /** What kayra itself says: a check's result, why a step stopped, a note. */
  | { readonly kind: "said"; readonly stream: "out" | "err"; readonly text: Text }
  /** A confirmation: the run waits until the browser answers. */
  | { readonly kind: "ask"; readonly prompt: Text }
  | { readonly kind: "answered" };

export type RunState = "running" | "passed" | "failed" | "interrupted" | "declined";

export type RunSummary = {
  readonly id: string;
  readonly command: string;
  readonly server?: string;
  readonly started: string;
  readonly state: RunState;
};

/** What the deployer's ctl answers for `runs --json`. */
export type AppRuns = {
  readonly app: string;
  readonly live?: { readonly sha: string; readonly time: string };
  readonly runs: readonly {
    readonly id: string;
    readonly state: "running" | "success" | "failure";
    readonly why: string;
    readonly what: string;
    readonly sha?: string;
    readonly started: string;
    readonly finished?: string;
  }[];
};

/** What the deployer's ctl answers for `rollback <app> --json`. */
export type AppReleases = { readonly app: string; readonly releases: readonly { readonly sha: string; readonly time: string; readonly live: boolean }[] };
