import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { err, ok, type Result } from "../result.ts";
import { field, registered, type App } from "./app.ts";
import { owner, runId, sha, type Sha } from "./brand.ts";
import type { Argv } from "./compose.ts";
import { body, json, send } from "./http.ts";
import { page, runPage } from "./page.ts";
import { spawnLines } from "./process.ts";
import type { Env } from "./run.ts";
import { forgeRepo, signed } from "./forge.ts";
import { pushedRef } from "./webhook.ts";

/**
 * The builder: the half of the deployer that faces app code and the internet.
 * No docker socket, no docker CLI, no app secrets. It clones app repos, builds
 * images through buildkitd, answers forge webhooks and shows the runs; the
 * deployer asks it for bundles and trusts none of what it returns.
 *
 *   :8080  Traefik → deploy.<domain>: POST /hook/<app> (signed per forge, no login), the
 *          runs pages (behind Authelia)
 *   :8081  platform-internal only: POST /resolve, POST /prepare
 */
type Settings = {
  readonly platformDir: string;
  readonly work: string;
  readonly deployer: string;
  readonly resolveImages: string;
  readonly webhookSecret: () => string;
  readonly gitToken: () => string;
};

const fromFile = (path: string): (() => string) => () => (existsSync(path) ? readFileSync(path, "utf8").trim() : "");

const settings = (env: NodeJS.ProcessEnv): Settings => {
  const platformDir = env["PLATFORM_DIR"] ?? "/opt/platform";
  return {
    platformDir,
    work: env["WORK_DIR"] ?? "/work",
    deployer: env["DEPLOYER_URL"] ?? "http://deployer:8090",
    resolveImages: env["RESOLVE_IMAGES"] ?? "/opt/kayra/scripts/platform/resolve-images.sh",
    webhookSecret: () => env["WEBHOOK_SECRET"] ?? "",
    gitToken: fromFile("/run/platform-secrets/GIT_TOKEN"),
  };
};

/** git with the platform's token as a header: neither in the clone's config nor in the process list. */
const gitEnv = (token: string): Env => ({
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "http.extraHeader",
  GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
});

/** A full commit id as it is; otherwise the branch or tag it names (a tag's commit, not the tag object). */
export const resolveRef = async (app: App, ref: string, token: string): Promise<Result<Sha, string>> => {
  const given = sha(ref);
  if (given.ok) return given;
  const exit = await spawnLines(
    ["git", "ls-remote", app.repo, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`],
    { env: gitEnv(token), capture: true, timeoutMs: 60_000 },
    () => undefined,
  );
  if (exit.code !== 0) return err(`git ls-remote ${app.repo} failed (exit ${String(exit.code)})`);
  const refs = new Map(
    exit.stdout.split("\n").flatMap((line) => {
      const [commit, name] = line.split("\t");
      return commit === undefined || name === undefined ? [] : [[name, commit] as const];
    }),
  );
  const found = refs.get(`refs/tags/${ref}^{}`) ?? refs.get(`refs/heads/${ref}`) ?? refs.get(`refs/tags/${ref}`);
  return found === undefined ? err(`${ref} is no branch or tag of ${app.repo}`) : sha(found);
};

type Line = (text: string) => void;

const run = async (argv: Argv, options: Parameters<typeof spawnLines>[1], line: Line): Promise<Result<string, string>> => {
  const exit = await spawnLines(argv, options, line);
  return exit.code === 0 ? ok(exit.stdout) : err(`${argv.slice(0, 3).join(" ")} failed (exit ${String(exit.code)})`);
};

const sequence = async (steps: readonly (() => Promise<Result<string, string>>)[]): Promise<Result<string, string>> =>
  steps.reduce<Promise<Result<string, string>>>(async (previous, next) => {
    const so = await previous;
    return so.ok ? next() : so;
  }, Promise.resolve(ok("")));

/**
 * One app's checkout at a commit, its images built where the registry lacks
 * them (resolve-images.sh, through buildkitd), and the compose files app.yml
 * lists at that commit. A clone per app, kept between runs; the deployer never
 * runs two for the same app at once, and neither does this.
 */
export const prepare = async (app: App, commit: Sha, s: Settings, line: Line): Promise<Result<unknown, string>> => {
  const dir = join(s.work, app.name);
  const env = gitEnv(s.gitToken());
  const git = (...args: readonly string[]): Promise<Result<string, string>> => run(["git", "-C", dir, ...args], { env, timeoutMs: 10 * 60_000 }, line);
  mkdirSync(dir, { recursive: true });
  const fresh = !existsSync(join(dir, ".git"));
  const checkedOut = await sequence([
    () => (fresh ? run(["git", "init", "-q", dir], {}, line) : Promise.resolve(ok(""))),
    () => (fresh ? git("remote", "add", "origin", app.repo) : git("remote", "set-url", "origin", app.repo)),
    () => git("fetch", "--quiet", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*", "+refs/tags/*:refs/tags/*"),
    async () => {
      const there = await git("checkout", "--quiet", "--force", "--detach", commit);
      return there.ok ? there : sequence([() => git("fetch", "--quiet", "origin", commit), () => git("checkout", "--quiet", "--force", "--detach", commit)]);
    },
    () => git("clean", "-ffdxq"),
  ]);
  if (!checkedOut.ok) return checkedOut;

  const root = join(dir, app.path);
  const buildEnv: Env = { REGISTRY: "localhost:5000" };
  const planned = await run(["bash", s.resolveImages, app.name, root, "--plan"], { env: buildEnv, capture: true }, line);
  if (!planned.ok) return planned;
  const artifacts = planned.value
    .split("\n")
    .filter((row) => row !== "")
    .map((row) => row.split("\t"));
  const built = await sequence(
    artifacts.map(([name]) => () => {
      line(`── Image ${name ?? "?"}`);
      return run(["bash", s.resolveImages, app.name, root, "--ensure", name ?? ""], { env: buildEnv }, line);
    }),
  );
  if (!built.ok) return built;

  const listed = await run(["yq", "-o=json", ".compose // []", join(root, "app.yml")], { capture: true }, line);
  if (!listed.ok) return listed;
  const files: unknown = JSON.parse(listed.value);
  if (!Array.isArray(files) || !files.every((file): file is string => typeof file === "string")) return err("app.yml: compose is not a list of paths");
  const outside = files.find((file) => file.startsWith("/") || file.split("/").includes(".."));
  if (outside !== undefined) return err(`app.yml: compose file ${outside} is outside the app`);
  const missing = files.find((file) => !existsSync(join(root, file)));
  if (missing !== undefined) return err(`app.yml: compose file ${missing} does not exist at ${commit}`);
  return ok({
    sha: commit,
    images: artifacts.map(([, variable, ref]) => ({ variable, ref })),
    compose: files.map((file) => ({ path: file, content: readFileSync(join(root, file), "utf8") })),
  });
};

const hook = async (s: Settings, name: string, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const raw = await body(request);
  const app = registered(s.platformDir, name);
  if (!app.ok) {
    send(response, 404, `${app.error}\n`);
    return;
  }
  const repo = forgeRepo(app.value.repo);
  if (raw === undefined || repo === undefined || !signed(repo, s.webhookSecret(), raw, request.headers)) {
    send(response, 401, "bad signature\n");
    return;
  }
  const ref = pushedRef(raw);
  if (ref !== `refs/heads/${app.value.ref}`) {
    send(response, 202, `ignored: ${ref ?? "not a push"} (deploys follow ${app.value.ref})\n`);
    return;
  }
  const forwarded = await fetch(`${s.deployer}/push/${app.value.name}`, { method: "POST" }).catch(() => undefined);
  send(response, forwarded?.ok === true ? 202 : 502, forwarded?.ok === true ? "queued\n" : "the deployer did not answer\n");
};

const pages = (s: Settings, path: string, response: ServerResponse): void => {
  const [, runs, who, id] = path.split("/");
  if (path === "/") {
    send(response, 200, page(join(s.platformDir, "runs")), "text/html; charset=utf-8");
    return;
  }
  const minted = owner(who ?? "");
  const run = runId(id ?? "");
  if (runs === "runs" && minted.ok && run.ok) {
    send(response, 200, runPage(join(s.platformDir, "runs"), minted.value, run.value), "text/html; charset=utf-8");
    return;
  }
  send(response, 404, "not found\n");
};

const internal = async (s: Settings, path: string, request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const input = await json(request);
  const name = typeof input === "object" && input !== null ? field(input, "app") : undefined;
  const app = registered(s.platformDir, typeof name === "string" ? name : "");
  if (!app.ok || typeof input !== "object" || input === null) {
    send(response, 404, `${app.ok ? "bad request" : app.error}\n`);
    return;
  }
  if (path === "/resolve") {
    const ref = field(input, "ref");
    const resolved = await resolveRef(app.value, typeof ref === "string" ? ref : app.value.ref, s.gitToken());
    send(response, resolved.ok ? 200 : 422, JSON.stringify(resolved.ok ? { sha: resolved.value } : { error: resolved.error }), "application/json");
    return;
  }
  const commit = sha(String(field(input, "sha")));
  if (path !== "/prepare" || !commit.ok) {
    send(response, 404, "not found\n");
    return;
  }
  // One JSON object per line: {log} as the build goes, then {bundle} or {error}.
  response.writeHead(200, { "Content-Type": "application/x-ndjson" });
  const prepared = await prepare(app.value, commit.value, s, (text) => response.write(`${JSON.stringify({ log: text })}\n`));
  response.end(`${JSON.stringify(prepared.ok ? { bundle: prepared.value } : { error: prepared.error })}\n`);
};

const failing = (handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> | void) => (request: IncomingMessage, response: ServerResponse) => {
  Promise.resolve(handler(request, response)).catch((error: unknown) => {
    console.error(error);
    if (!response.headersSent) send(response, 500, "internal error\n");
    else response.end();
  });
};

export const serveBuilder = (env: NodeJS.ProcessEnv): void => {
  const s = settings(env);
  createServer(
    failing(async (request, response) => {
      const path = new URL(request.url ?? "/", "http://builder").pathname;
      const hooked = /^\/hook\/([^/]+)\/?$/.exec(path);
      if (request.method === "POST" && hooked?.[1] !== undefined) await hook(s, hooked[1], request, response);
      else if (request.method === "GET") pages(s, path, response);
      else send(response, 405, "method not allowed\n");
    }),
  ).listen(8080);
  createServer(
    failing(async (request, response) => {
      const path = new URL(request.url ?? "/", "http://builder").pathname;
      if (request.method === "POST") await internal(s, path, request, response);
      else send(response, 405, "method not allowed\n");
    }),
  ).listen(8081);
  console.log("builder: :8080 hooks and pages, :8081 resolve and prepare");
};
