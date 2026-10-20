import { z } from "zod";
import { valueKeySchema } from "../app-values/model.ts";

/**
 * Every kayra operation, once: what each client (the command line, the API,
 * the web interface) offers, and what it may ask for. A client names an
 * operation and gives its input as plain JSON; the core checks it here, binds
 * it to the fleet and runs it. A new operation is added here, and each client's
 * coverage table refuses to compile until it offers it too.
 */

/** What an operation acts on: the fleet as a whole, one server, one app on a server, or an app's own repository. */
export const scopes = ["fleet", "server", "app", "repo"] as const;
export type Scope = (typeof scopes)[number];

/** What it does to the world: a client asks before a change to a real server, and twice before destroying. */
export const effects = ["reads", "changes", "destroys"] as const;
export type Effect = (typeof effects)[number];

/**
 * How it runs: a plan of steps (shown before, followed while), a query
 * answering at once, a stream of answers as they land (status), or an interactive session.
 */
export const kinds = ["plan", "query", "stream", "session"] as const;
export type Kind = (typeof kinds)[number];

export type Operation = {
  readonly summary: string;
  readonly scope: Scope;
  readonly effect: Effect;
  readonly kind: Kind;
  /** Its output is its answer (ssh, a deployer's): a client draws nothing around it. */
  readonly bare?: true;
  /** Edits this machine’s fleet files, without changing a running server. */
  readonly local?: true;
  readonly input: z.ZodType;
};

const server = z.string().min(1).describe("A server of the fleet (servers/<name>/)");
const app = z.string().min(1).describe("An app name, including a removed app whose records or data remain");
const serverInput = z.strictObject({ server });
const appInput = z.strictObject({ server, app });
const dir = z.string().min(1).optional().describe("Local app directory containing app.yml; otherwise use the fleet cache");

export const operations = {
  up: {
    summary: "Provision, set up everything, point /etc/hosts at it.",
    scope: "server",
    effect: "changes",
    kind: "plan",
    input: serverInput,
  },
  provision: {
    summary: "Create or update the machine (target home: build the image to import).",
    scope: "server",
    effect: "changes",
    kind: "plan",
    input: serverInput,
  },
  deploy: { summary: "Host setup and every app, no provisioning.", scope: "server", effect: "changes", kind: "plan", input: serverInput },
  setup: { summary: "The host layer only: the playbook for the server's kind.", scope: "server", effect: "changes", kind: "plan", input: serverInput },
  plan: {
    summary: "What provision and setup would change, changing nothing (OpenTofu plan, Ansible check mode).",
    scope: "server",
    effect: "reads",
    kind: "plan",
    input: serverInput,
  },
  verify: {
    summary: "Whether a platform server works as its users see it: logins, certificates, webhooks, apps, runs, alerts.",
    scope: "server",
    effect: "reads",
    kind: "plan",
    input: serverInput,
  },
  apps: {
    summary: "Make the server's apps match server.yml: register each, remove the rest (data kept).",
    scope: "server",
    effect: "changes",
    kind: "plan",
    input: serverInput,
  },
  hosts: { summary: "Point the domain at a multipass VM in /etc/hosts (sudo).", scope: "server", effect: "changes", kind: "plan", input: serverInput },
  ssh: { summary: "Open an interactive SSH session.", scope: "server", effect: "changes", kind: "session", bare: true, input: serverInput },
  "ssh.exec": {
    summary: "Run a command over SSH.", scope: "server", effect: "changes", kind: "plan", bare: true,
    input: z.strictObject({ server, command: z.array(z.string()).min(1).describe("The remote command and arguments") }),
  },
  down: { summary: "Destroy the machine.", scope: "server", effect: "destroys", kind: "plan", input: serverInput },
  adopt: {
    summary: "Once, for a server we did not create: add the deploy user as root.",
    scope: "server",
    effect: "changes",
    kind: "plan",
    input: serverInput,
  },
  "backup.test": {
    summary: "Restore the latest backup to a scratch dir, check it, delete it.",
    scope: "server",
    effect: "changes",
    kind: "plan",
    input: serverInput,
  },
  "app.init": {
    summary: "Make an existing project with a compose file or Dockerfile deployable: write app.yml and the platform's overlay, then check it.",
    scope: "repo",
    effect: "changes",
    kind: "plan",
    input: z.strictObject({
      dir: z.string().min(1).default(".").describe("The project's repository"),
      name: z.string().min(1).optional().describe("The app's name; the directory's by default"),
    }),
  },
  "app.check": {
    summary: "What the platform checks at deploy (app.yml, images, compose policy), in an app's repository. No fleet needed.",
    scope: "repo",
    effect: "reads",
    kind: "plan",
    input: z.strictObject({ dir: z.string().min(1).default(".").describe("The app's repository") }),
  },
  "app.values": {
    summary: "Which configuration and secrets app.yml declares, and whether each has a value; never the values.",
    scope: "app", effect: "reads", kind: "query", input: z.strictObject({ server, app, dir }),
  },
  "app.config.set": {
    summary: "Prepare a declared configuration value in the local fleet; apply separately with apps.",
    scope: "app", effect: "changes", kind: "plan", local: true,
    input: z.strictObject({ server, app, dir, key: valueKeySchema, value: z.string().min(1).refine((value) => !value.includes("\0"), "NUL is not an environment value") }),
  },
  "app.secret.import": {
    summary: "Import a declared secret from a local file into the fleet vault; never print its value.",
    scope: "app", effect: "changes", kind: "plan", local: true,
    input: z.strictObject({ server, app, dir, key: valueKeySchema, file: z.string().min(1).describe("Local file containing the secret, not YAML; one trailing newline is removed") }),
  },
  "app.secret.generate": {
    summary: "Generate a 32-byte random secret in the fleet only if missing; preserve existing values.",
    scope: "app", effect: "changes", kind: "plan", local: true,
    input: z.strictObject({ server, app, dir, key: valueKeySchema }),
  },
  "app.launch": {
    summary: "From a repository to a URL that answers: register the app, check its values, apply the apps, deploy and follow it. Run it again after a stop.",
    scope: "app", effect: "changes", kind: "plan",
    input: z.strictObject({
      server, app, dir,
      repo: z.string().min(1).optional().describe("The app's repository, https://; needed until server.yml registers it"),
      ref: z.string().min(1).optional().describe("The branch that deploys (default main)"),
      path: z.string().min(1).optional().describe("The app's root inside the repository (default .)"),
    }),
  },
  "app.hook": {
    summary: "Wire an app's GitHub repository to its server: check the platform's token reads it, create or update its push webhook.",
    scope: "app", effect: "changes", kind: "plan", input: appInput,
  },
  "app.purge": { summary: "Delete a removed app's volumes: its data, irreversibly.", scope: "app", effect: "destroys", kind: "plan", input: appInput },
  "app.runs": {
    summary: "What runs now, and the app's latest runs: state, commit, why, when, how long.",
    scope: "app",
    effect: "reads",
    kind: "query",
    bare: true,
    input: appInput,
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
    input: appInput,
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
const described: Readonly<Record<OperationName, Operation>> = operations;

export const operation = (name: OperationName) => described[name];

/** An operation, with its input as its schema has it: what every client hands the core. */
export type Invocation = { readonly [N in OperationName]: { readonly name: N; readonly input: InputOf<N> } }[OperationName];
