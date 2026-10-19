import { resolve } from "node:path";
import { z } from "zod";
import { absolutePath, appName, domain, subdomain, within, type AbsolutePath, type AppName } from "../fleet/brand.ts";
import { appCheck } from "../recipes/app-check.ts";
import { doctor } from "../recipes/doctor.ts";
import { appPurge, apps, deployer, type DeployerCommand } from "../recipes/apps.ts";
import type { Engine } from "../recipes/steps.ts";
import { adopt, deploy, down, hosts, preview, provision, setup, up, verify } from "../recipes/host.ts";
import { backupTest } from "../recipes/backup.ts";
import { certsFor } from "../recipes/certs.ts";
import { ssh } from "../recipes/ssh.ts";
import { look } from "../status/look.ts";
import type { Network, Tofu } from "../status/ports.ts";
import type { Watched } from "../status/model.ts";
import { findings, type Report } from "../validation/findings.ts";
import type { Fleet, Server } from "../fleet/model.ts";
import { gather } from "../validation/facts.ts";
import { interpret } from "../interpreter/loop.ts";
import type { Io } from "../interpreter/io.ts";
import { flat } from "../text/spans.ts";
import type { Plan } from "../plan/model.ts";
import { all, err, flatMap, map, ok, type Result } from "../../result.ts";
import { operations, type InputOf, type Invocation, type PlanName, type QueryName, type SessionName, type StreamName } from "./catalog.ts";

/** What the core runs an operation with: the engine, the fleet, and the world as the client's machine sees it. */
export type Context = {
  readonly engine: Engine;
  readonly fleet: Fleet;
  readonly version: string;
  /** Where a relative path starts: the directory kayra was started in. */
  readonly here: AbsolutePath;
  /** A file's text, or undefined where there is none. */
  readonly read: (path: AbsolutePath) => string | undefined;
  readonly network: Network;
  readonly tofu: Tofu;
  readonly signal?: Io["signal"];
};

/** Every operation with its input: what a client sends, parsed in one go. */
const invocations = z.discriminatedUnion("name", [
  z.strictObject({ name: z.literal("up"), input: operations.up.input }),
  z.strictObject({ name: z.literal("provision"), input: operations.provision.input }),
  z.strictObject({ name: z.literal("deploy"), input: operations.deploy.input }),
  z.strictObject({ name: z.literal("setup"), input: operations.setup.input }),
  z.strictObject({ name: z.literal("plan"), input: operations.plan.input }),
  z.strictObject({ name: z.literal("verify"), input: operations.verify.input }),
  z.strictObject({ name: z.literal("apps"), input: operations.apps.input }),
  z.strictObject({ name: z.literal("hosts"), input: operations.hosts.input }),
  z.strictObject({ name: z.literal("ssh"), input: operations.ssh.input }),
  z.strictObject({ name: z.literal("ssh.exec"), input: operations["ssh.exec"].input }),
  z.strictObject({ name: z.literal("down"), input: operations.down.input }),
  z.strictObject({ name: z.literal("adopt"), input: operations.adopt.input }),
  z.strictObject({ name: z.literal("backup.test"), input: operations["backup.test"].input }),
  z.strictObject({ name: z.literal("app.check"), input: operations["app.check"].input }),
  z.strictObject({ name: z.literal("app.purge"), input: operations["app.purge"].input }),
  z.strictObject({ name: z.literal("app.runs"), input: operations["app.runs"].input }),
  z.strictObject({ name: z.literal("app.log"), input: operations["app.log"].input }),
  z.strictObject({ name: z.literal("app.deploy"), input: operations["app.deploy"].input }),
  z.strictObject({ name: z.literal("app.releases"), input: operations["app.releases"].input }),
  z.strictObject({ name: z.literal("app.rollback"), input: operations["app.rollback"].input }),
  z.strictObject({ name: z.literal("job"), input: operations.job.input }),
  z.strictObject({ name: z.literal("status"), input: operations.status.input }),
  z.strictObject({ name: z.literal("validate"), input: operations.validate.input }),
  z.strictObject({ name: z.literal("doctor"), input: operations.doctor.input }),
  z.strictObject({ name: z.literal("certs"), input: operations.certs.input }),
  z.strictObject({ name: z.literal("version"), input: operations.version.input }),
]) satisfies z.ZodType<Invocation>;

/** An operation and input from any client, checked against its schema: the one gate into the core. */
export const invocation = (name: string, input: unknown): Result<Invocation, string> => {
  const parsed = invocations.safeParse({ name, input: input ?? {} });
  if (parsed.success) return ok(parsed.data);
  const issue = parsed.error.issues[0];
  const where = issue?.path.slice(1).join(".") ?? "";
  return err(name in operations ? `${name}: ${where === "" ? "input" : where}: ${issue?.message ?? "invalid"}` : `no operation '${name}'`);
};

const onServer = (ctx: Context, name: string): Result<Server, string> => {
  const found = ctx.fleet.servers.find((each) => each.name === name);
  return found === undefined ? err(`no server '${name}' in this fleet`) : ok(found);
};

/**
 * A server and an app's name. The app need not be in server.yml: a removed
 * app's runs, logs and volumes stay the deployer's to answer for and purge.
 */
const onApp = (ctx: Context, input: { readonly server: string; readonly app: string }): Result<readonly [Server, AppName], string> =>
  flatMap(onServer(ctx, input.server), (target) => map(appName(input.app), (app) => [target, app] as const));

type RecipeName = PlanName | SessionName | "app.runs" | "app.log" | "app.releases";
type Plans = { readonly [N in RecipeName]: (ctx: Context, input: InputOf<N>) => Result<Plan, string> };

const withServer =
  (make: (engine: Engine, target: Server) => Result<Plan, string>) =>
  (ctx: Context, input: { readonly server: string }): Result<Plan, string> =>
    flatMap(onServer(ctx, input.server), (target) => make(ctx.engine, target));

const onDeployer =
  (command: (app: AppName, input: Readonly<Record<string, unknown>>) => DeployerCommand) =>
  (ctx: Context, input: { readonly server: string; readonly app: string }): Result<Plan, string> =>
    flatMap(onApp(ctx, input), ([target, app]) => deployer(target, command(app, input)));

const optional = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Each plan operation, as the plan that does it: the compiler refuses one that has none. */
const plans: Plans = {
  up: withServer(up),
  provision: withServer(provision),
  deploy: withServer(deploy),
  setup: withServer(setup),
  plan: withServer(preview),
  verify: withServer(verify),
  apps: withServer(apps),
  hosts: withServer(hosts),
  down: withServer(down),
  adopt: withServer(adopt),
  "backup.test": withServer(backupTest),
  ssh: (ctx, input) => flatMap(onServer(ctx, input.server), (target) => ssh(target, [])),
  "ssh.exec": (ctx, input) => flatMap(onServer(ctx, input.server), (target) => ssh(target, input.command)),
  "app.check": (ctx, input) =>
    flatMap(absolutePath(resolve(ctx.here, input.dir)), (dir) => appCheck(ctx.engine.kayra, dir, ctx.read(within(dir, "app.yml")))),
  "app.purge": (ctx, input) => flatMap(onApp(ctx, input), ([target, app]) => appPurge(ctx.engine, target, app)),
  "app.runs": onDeployer((app) => ({ kind: "runs", app, more: undefined })),
  "app.log": onDeployer((app, input) => ({ kind: "logs", app, more: optional(input["run"]) })),
  "app.deploy": onDeployer((app, input) => ({ kind: "deploy", app, more: optional(input["ref"]) })),
  "app.releases": onDeployer((app) => ({ kind: "rollback", app, more: undefined })),
  "app.rollback": onDeployer((app, input) => ({ kind: "rollback", app, more: optional(input["sha"]) })),
  job: (ctx, input) => flatMap(onServer(ctx, input.server), (target) => deployer(target, { kind: "job", job: input.job, noPrs: input.noPrs })),
  doctor: (ctx) => ok(doctor(ctx.fleet, ctx.engine.kayra)),
  certs: (ctx, input) =>
    flatMap(domain(input.domain), (named) =>
      flatMap(all(input.subdomains.map(subdomain)), (subdomains) => certsFor(ctx.engine, named, subdomains)),
    ),
};

/** An operation backed by a plan, its name and input still paired. */
export type RecipeCall = { readonly [N in RecipeName]: { readonly name: N; readonly input: InputOf<N> } }[RecipeName];

export const planOf = <N extends RecipeName>(ctx: Context, call: { readonly name: N; readonly input: InputOf<N> }): Result<Plan, string> =>
  plans[call.name](ctx, call.input);

export const hasPlan = (call: Invocation): call is RecipeCall => Object.hasOwn(plans, call.name);

/** What each query answers. */
export type Answers = { readonly validate: readonly Report[]; readonly version: string; readonly "app.runs": string; readonly "app.releases": string; readonly "app.log": string };

type Queries = { readonly [N in QueryName]: (ctx: Context, input: InputOf<N>) => Promise<Result<Answers[N], string>> };

const deployerAnswer = async (ctx: Context, name: "app.runs" | "app.releases" | "app.log", input: InputOf<typeof name>): Promise<Result<string, string>> => {
  const plan = planOf(ctx, { name, input });
  if (!plan.ok) return plan;
  // eslint-disable-next-line functional/prefer-immutable-types -- the interpreter's captured streams
  const said: { stdout: string; stderr: string } = { stdout: "", stderr: "" };
  const passed = await interpret(plan.value.map((step) => step.kind === "run" ? { ...step, stdout: "show" } : step), {
    out: () => undefined,
    // eslint-disable-next-line functional/immutable-data -- capturing interpreter diagnostics
    err: (text) => { said.stderr += flat(text); },
    ask: () => Promise.resolve(""),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    output: (chunk, stream) => {
      // eslint-disable-next-line functional/immutable-data -- capturing program output
      if (stream === "stdout") said.stdout += chunk;
      // eslint-disable-next-line functional/immutable-data -- capturing program errors
      else said.stderr += chunk;
    },
  });
  return passed ? ok(said.stdout) : err(said.stderr.trim() || "the deployer query failed");
};

const queries: Queries = {
  "app.runs": (ctx, input) => deployerAnswer(ctx, "app.runs", input),
  "app.releases": (ctx, input) => deployerAnswer(ctx, "app.releases", input),
  "app.log": (ctx, input) => deployerAnswer(ctx, "app.log", input),
  validate: async (ctx, input) => {
    const chosen = input.server === undefined ? ok(ctx.fleet.servers) : map(onServer(ctx, input.server), (one) => [one]);
    if (!chosen.ok) return chosen;
    return ok(await Promise.all(chosen.value.map(async (each) => ({ server: each, findings: findings(await gather(ctx.fleet.root, each)) }))));
  },
  version: (ctx) => Promise.resolve(ok(ctx.version)),
};

export const query = <N extends QueryName>(ctx: Context, name: N, input: InputOf<N>): Promise<Result<Answers[N], string>> => queries[name](ctx, input);

type Streams = { readonly [N in StreamName]: (ctx: Context, input: InputOf<N>) => Watched };

const streams: Streams = {
  status: (ctx, input) => look(ctx.fleet, ctx.tofu, input.offline ? undefined : ctx.network),
};

/** A stream's first state and the updates still to land. */
export const stream = <N extends StreamName>(ctx: Context, name: N, input: InputOf<N>): Watched => streams[name](ctx, input);

/** The server an invocation acts on, if one: what its heading names, what a real server's confirmation asks for. */
export const serverOf = (ctx: Context, invocation: Invocation): Server | undefined => {
  const named: unknown = "server" in invocation.input ? invocation.input.server : undefined;
  return typeof named === "string" ? ctx.fleet.servers.find((each) => each.name === named) : undefined;
};

export type QueryCall = { readonly [N in QueryName]: { readonly name: N; readonly input: InputOf<N> } }[QueryName];
export const isQuery = (call: Invocation): call is QueryCall => operations[call.name].kind === "query";

export type StreamCall = { readonly [N in StreamName]: { readonly name: N; readonly input: InputOf<N> } }[StreamName];
export const isStream = (call: Invocation): call is StreamCall => operations[call.name].kind === "stream";
