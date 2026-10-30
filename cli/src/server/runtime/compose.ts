import { typed } from "../../lib/typed.ts";
import type { Argv } from "../../contracts/process.ts";

export type { Argv } from "../../contracts/process.ts";
export type Env = Readonly<Record<string, string>>;
export type Exit = { readonly code: number; readonly stdout: string };
export type ComposeApp = { readonly name: string };
export type ComposeBundle = { readonly compose: readonly { readonly path: string }[] };
export type ComposeRequest = {
  readonly app: ComposeApp;
  readonly appsDir: string;
  readonly bundle: ComposeBundle;
  readonly cwd: string;
  readonly env: Env;
};
export type ComposeRuntime = {
  readonly config: (request: ComposeRequest) => Promise<Exit>;
  readonly up: (request: ComposeRequest) => Promise<Exit>;
};
export type Execute = (argv: Argv, options: { readonly cwd: string; readonly env: Env; readonly stdin?: string; readonly capture?: boolean }) => Promise<Exit>;
export type Observe = (argv: Argv, options: { readonly cwd: string; readonly env: Env; readonly capture: boolean; readonly timeoutMs: number }) => Promise<Exit>;

export const appFiles = "app";
export const imagesFile = "images.env";
export const routesFile = "routes.yml";

// Explicit -p prevents an inherited COMPOSE_PROJECT_NAME from choosing another project.
const project = (app: ComposeApp, appsDir: string, bundle: ComposeBundle) => {
  const dir = `${appsDir}/${app.name}`;
  return typed<readonly string[]>([
    "compose", "-p", app.name, "--project-directory", dir, "--env-file", `${dir}/.env`, "--env-file", imagesFile,
    ...bundle.compose.flatMap((file) => ["-f", `${appFiles}/${file.path}`] as const),
  ]);
};

// Do not resolve env_file before policy checks it; it could read another app's secrets.
export const config = (app: ComposeApp, appsDir: string, bundle: ComposeBundle) => typed<Argv>([
  "docker", ...project(app, appsDir, bundle), "config", "--no-env-resolution", "--format", "json",
]);

// Remove services dropped from this app's compose files.
export const up = (app: ComposeApp, appsDir: string, bundle: ComposeBundle) => typed<Argv>([
  "docker", ...project(app, appsDir, bundle), "-f", routesFile, "up", "-d", "--wait", "--wait-timeout", "180", "--remove-orphans",
]);

export const composeRuntime = (exec: Execute) => typed<ComposeRuntime>({
  config: ({ app, appsDir, bundle, cwd, env }) => exec(config(app, appsDir, bundle), { cwd, env, capture: true }),
  up: ({ app, appsDir, bundle, cwd, env }) => exec(up(app, appsDir, bundle), { cwd, env }),
});

/** An observation failure must not cause the legacy restorer to deploy over a running app. */
export const composeProjectRunning = async (app: ComposeApp, observe: Observe) => {
  const exit = await observe(
    ["docker", "ps", "-q", "--filter", `label=com.docker.compose.project=${app.name}`, "--filter", "status=running", "--filter", "status=restarting"],
    { cwd: "/", env: {}, capture: true, timeoutMs: 30_000 },
  );
  return exit.code !== 0 || exit.stdout.trim() !== "";
};
