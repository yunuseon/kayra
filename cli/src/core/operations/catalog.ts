import { z } from "zod";

/**
 * Every kayra operation, once: what each client (the command line, the API,
 * the web interface) offers, and what it may ask for. A client names an
 * operation and gives its input as plain JSON; the core checks it here, binds
 * it to the fleet and runs it. A new operation is added here, and each client's
 * coverage table refuses to compile until it offers it too.
 */

/** What an operation acts on: the fleet as a whole, one server, one app on a server, or an app's own repository. */
export type Scope = "fleet" | "server" | "app" | "repo";

/** What it does to the world: a client asks before a change to a real server, and twice before destroying. */
export type Effect = "reads" | "changes" | "destroys";

/**
 * How it runs: a plan of steps (shown before, followed while), a query
 * answering at once, a stream of answers as they land (status), or an interactive session.
 */
export type Kind = "plan" | "query" | "stream" | "session";

export type Operation = {
  readonly summary: string;
  readonly scope: Scope;
  readonly effect: Effect;
  readonly kind: Kind;
  /** Its output is its answer (ssh, a deployer's): a client draws nothing around it. */
  readonly bare?: true;
  readonly input: z.ZodType;
};

const server = z.string().min(1).describe("A server of the fleet (servers/<name>/)");
const app = z.string().min(1).describe("An app name, including a removed app whose records or data remain");
const onServer = z.strictObject({ server });
const onApp = z.strictObject({ server, app });

export const operations = {
  up: {
    summary: "Provision, set up everything, point /etc/hosts at it.",
    scope: "server",
    effect: "changes",
    kind: "plan",
    input: onServer,
  },
  provision: {
    summary: "Create or update the machine (target home: build the image to import).",
    scope: "server",
    effect: "changes",
    kind: "plan",
    input: onServer,
  },
  deploy: { summary: "Host setup and every app, no provisioning.", scope: "server", effect: "changes", kind: "plan", input: onServer },
  setup: { summary: "The host layer only: the playbook for the server's kind.", scope: "server", effect: "changes", kind: "plan", input: onServer },
  plan: {
    summary: "What provision and setup would change, changing nothing (OpenTofu plan, Ansible check mode).",
    scope: "server",
    effect: "reads",
    kind: "plan",
    input: onServer,
  },
  verify: {
    summary: "Whether a platform server works as its users see it: logins, certificates, webhooks, apps, runs, alerts.",
    scope: "server",
    effect: "reads",
    kind: "plan",
    input: onServer,
  },
  apps: {
    summary: "Make the server's apps match server.yml: register each, remove the rest (data kept).",
    scope: "server",
    effect: "changes",
    kind: "plan",
    input: onServer,
  },
  hosts: { summary: "Point the domain at a multipass VM in /etc/hosts (sudo).", scope: "server", effect: "changes", kind: "plan", input: onServer },
  ssh: { summary: "Open an interactive SSH session.", scope: "server", effect: "changes", kind: "session", bare: true, input: onServer },
  "ssh.exec": {
    summary: "Run a command over SSH.", scope: "server", effect: "changes", kind: "plan", bare: true,
    input: z.strictObject({ server, command: z.array(z.string()).min(1).describe("The remote command and arguments") }),
  },
  down: { summary: "Destroy the machine.", scope: "server", effect: "destroys", kind: "plan", input: onServer },
  adopt: {
    summary: "Once, for a server we did not create: add the deploy user as root.",
    scope: "server",
    effect: "changes",
    kind: "plan",
    input: onServer,
  },
  "backup.test": {
    summary: "Restore the latest backup to a scratch dir, check it, delete it.",
    scope: "server",
    effect: "changes",
    kind: "plan",
    input: onServer,
  },
  "app.check": {
    summary: "What the platform checks at deploy (app.yml, images, compose policy), in an app's repository. No fleet needed.",
    scope: "repo",
    effect: "reads",
    kind: "plan",
    input: z.strictObject({ dir: z.string().min(1).default(".").describe("The app's repository") }),
  },
  "app.purge": { summary: "Delete a removed app's volumes: its data, irreversibly.", scope: "app", effect: "destroys", kind: "plan", input: onApp },
  "app.runs": {
    summary: "What runs now, and the app's latest runs: state, commit, why, when, how long.",
    scope: "app",
    effect: "reads",
    kind: "query",
    bare: true,
    input: onApp,
  },
  "app.log": {
    summary: "A run's log, the newest unless named; its errors and warnings marked.",
    scope: "app",
    effect: "reads",
    kind: "query",
    bare: true,
    input: z.strictObject({ server, app, run: z.string().min(1).optional().describe("A run's id; the newest by default") }),
  },
  "app.deploy": {
    summary: "Build and deploy a branch, tag or commit (default: the app's ref).",
    scope: "app",
    effect: "changes",
    kind: "plan",
    bare: true,
    input: z.strictObject({ server, app, ref: z.string().min(1).optional().describe("A branch, tag or commit; the app's ref by default") }),
  },
  "app.releases": {
    summary: "The app's releases: what runs now, and the earlier ones to roll back to.",
    scope: "app",
    effect: "reads",
    kind: "query",
    bare: true,
    input: onApp,
  },
  "app.rollback": {
    summary: "Deploy an earlier release again.",
    scope: "app",
    effect: "changes",
    kind: "plan",
    bare: true,
    input: z.strictObject({ server, app, sha: z.string().regex(/^[0-9a-f]{7,40}$/).describe("An earlier release's commit") }),
  },
  job: {
    summary: "Run a platform job now: the registry GC or Renovate.",
    scope: "server",
    effect: "changes",
    kind: "plan",
    bare: true,
    input: z.strictObject({
      server,
      job: z.enum(["gc", "renovate"]),
      noPrs: z.boolean().default(false).describe("Renovate: log what would change, open no PRs"),
    }),
  },
  status: {
    summary: "Every server: where it is, whether SSH and its login answer.",
    scope: "fleet",
    effect: "reads",
    kind: "stream",
    input: z.strictObject({ offline: z.boolean().default(false).describe("Only what the fleet and OpenTofu's state say: reach no server") }),
  },
  validate: {
    summary: "Check the fleet beyond its schemas: secrets, apps against their contract, stacks, routes.",
    scope: "fleet",
    effect: "reads",
    kind: "query",
    input: z.strictObject({ server: server.optional() }),
  },
  doctor: { summary: "Check that this Mac can run every command on every server.", scope: "fleet", effect: "reads", kind: "plan", input: z.strictObject({}) },
  certs: {
    summary: "mkcert certs for a domain and its subdomains (local dev, multipass).",
    scope: "fleet",
    effect: "changes",
    kind: "plan",
    input: z.strictObject({ domain: z.string().min(1), subdomains: z.array(z.string()).default([]) }),
  },
  version: { summary: "Which kayra this is.", scope: "fleet", effect: "reads", kind: "query", input: z.strictObject({}) },
} as const satisfies Readonly<Record<string, Operation>>;

export type OperationName = keyof typeof operations;

/** A value nothing may change, however deep: zod infers mutable arrays and objects. */
type Frozen<T> = T extends readonly (infer U)[] ? readonly Frozen<U>[] : T extends object ? { readonly [K in keyof T]: Frozen<T[K]> } : T;

export type InputOf<N extends OperationName> = Frozen<z.infer<(typeof operations)[N]["input"]>>;

type OfKind<K extends Kind> = { readonly [N in OperationName]: (typeof operations)[N]["kind"] extends K ? N : never }[OperationName];
export type PlanName = OfKind<"plan">;
export type QueryName = OfKind<"query">;
export type StreamName = OfKind<"stream">;
export type SessionName = OfKind<"session">;

export const operationNames = Object.keys(operations).filter((name): name is OperationName => Object.hasOwn(operations, name));

export const isOperation = (name: string): name is OperationName => Object.hasOwn(operations, name);

/** An operation as every client reads it, whatever its own entry spells out. */
export const operation = (name: OperationName): Operation => operations[name];

/** An operation, with its input as its schema has it: what every client hands the core. */
export type Invocation = { readonly [N in OperationName]: { readonly name: N; readonly input: InputOf<N> } }[OperationName];
