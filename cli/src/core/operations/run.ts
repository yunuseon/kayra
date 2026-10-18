import { resolve } from "node:path";
import { z } from "zod";
import { absolutePath, appName, domain, subdomain, within, type AbsolutePath, type AppName } from "../brand.ts";
import { appCheck } from "../commands/app-check.ts";
import { doctor } from "../commands/doctor.ts";
import * as server from "../commands/server.ts";
import { look, type Network, type Tofu, type Watched } from "../commands/status.ts";
import { findings, type Report } from "../commands/validate.ts";
import type { Fleet, Server } from "../fleet.ts";
import { gather } from "../gather.ts";
import type { Plan } from "../plan.ts";
import { all, err, flatMap, map, ok, type Result } from "../../result.ts";
import { operations, type InputOf, type Invocation, type PlanName, type QueryName, type StreamName } from "./catalog.ts";

/** What the core runs an operation with: the engine, the fleet, and the world as the client's machine sees it. */
export type Context = {
  readonly engine: server.Engine;
  readonly fleet: Fleet;
  readonly version: string;
  /** Where a relative path starts: the directory kayra was started in. */
  readonly here: AbsolutePath;
  /** A file's text, or undefined where there is none. */
  readonly read: (path: AbsolutePath) => string | undefined;
  readonly network: Network;
  readonly tofu: Tofu;
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

type Plans = { readonly [N in PlanName]: (ctx: Context, input: InputOf<N>) => Result<Plan, string> };

const withServer =
  (make: (engine: server.Engine, target: Server) => Result<Plan, string>) =>
  (ctx: Context, input: { readonly server: string }): Result<Plan, string> =>
    flatMap(onServer(ctx, input.server), (target) => make(ctx.engine, target));

const onDeployer =
  (command: (app: AppName, input: Readonly<Record<string, unknown>>) => server.DeployerCommand) =>
  (ctx: Context, input: { readonly server: string; readonly app: string }): Result<Plan, string> =>
    flatMap(onApp(ctx, input), ([target, app]) => server.deployer(target, command(app, input)));

const optional = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Each plan operation, as the plan that does it: the compiler refuses one that has none. */
const plans: Plans = {
  up: withServer(server.up),
  provision: withServer(server.provision),
  deploy: withServer(server.deploy),
  setup: withServer(server.setup),
  plan: withServer(server.preview),
  verify: withServer(server.verify),
  apps: withServer(server.apps),
  hosts: withServer(server.hosts),
  down: withServer(server.down),
  adopt: withServer(server.adopt),
  "backup.test": withServer(server.backupTest),
  ssh: (ctx, input) => flatMap(onServer(ctx, input.server), (target) => server.ssh(target, input.command)),
  "app.check": (ctx, input) =>
    flatMap(absolutePath(resolve(ctx.here, input.dir)), (dir) => appCheck(ctx.engine.kayra, dir, ctx.read(within(dir, "app.yml")))),
  "app.purge": (ctx, input) => flatMap(onApp(ctx, input), ([target, app]) => server.appPurge(ctx.engine, target, app)),
  "app.runs": onDeployer((app) => ({ kind: "runs", app, more: undefined })),
  "app.log": onDeployer((app, input) => ({ kind: "logs", app, more: optional(input["run"]) })),
  "app.deploy": onDeployer((app, input) => ({ kind: "deploy", app, more: optional(input["ref"]) })),
  "app.releases": onDeployer((app) => ({ kind: "rollback", app, more: undefined })),
  "app.rollback": onDeployer((app, input) => ({ kind: "rollback", app, more: optional(input["sha"]) })),
  job: (ctx, input) => flatMap(onServer(ctx, input.server), (target) => server.deployer(target, { kind: "job", job: input.job, noPrs: input.noPrs })),
  doctor: (ctx) => ok(doctor(ctx.fleet, ctx.engine.kayra)),
  certs: (ctx, input) =>
    flatMap(domain(input.domain), (named) =>
      flatMap(all(input.subdomains.map(subdomain)), (subdomains) => server.certsFor(ctx.engine, named, subdomains)),
    ),
};

/** An invocation of a plan operation, its name and input still paired. */
export type PlanCall = { readonly [N in PlanName]: { readonly name: N; readonly input: InputOf<N> } }[PlanName];

export const planOf = <N extends PlanName>(ctx: Context, call: { readonly name: N; readonly input: InputOf<N> }): Result<Plan, string> =>
  plans[call.name](ctx, call.input);

export const isPlan = (call: Invocation): call is PlanCall => operations[call.name].kind === "plan";

/** What each query answers. */
export type Answers = { readonly validate: readonly Report[]; readonly version: string };

type Queries = { readonly [N in QueryName]: (ctx: Context, input: InputOf<N>) => Promise<Result<Answers[N], string>> };

const queries: Queries = {
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
