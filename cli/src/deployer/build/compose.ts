import type { App } from "../app.ts";
import type { Bundle } from "./bundle.ts";
import { wireRoutes } from "./routes.ts";
import { typed } from "../../lib/typed.ts";

export type Argv = readonly [string, ...string[]];

/**
 * The run's directory: the app's compose files under app/, at their paths in
 * the app; the platform's files beside it, where no app file can stand in for
 * them.
 */
export const appFiles = "app";
export const imagesFile = "images.env";
export const routesFile = "routes.yml";

/**
 * The app's compose project, run in the run's directory: its .env from the
 * platform (operator config), the image refs from this run, the compose files
 * from the commit being deployed. Never COMPOSE_PROJECT_NAME from the
 * environment: -p names the project.
 */
const project = (app: App, appsDir: string, bundle: Bundle) => {
  const dir = `${appsDir}/${app.name}`;
  return typed<readonly string[]>([
    "compose", "-p", app.name, "--project-directory", dir, "--env-file", `${dir}/.env`, "--env-file", imagesFile,
    ...bundle.compose.flatMap((file) => ["-f", `${appFiles}/${file.path}`] as const),
  ]);
};

/**
 * What admission checks: the app's files alone. --no-env-resolution:
 * otherwise compose reads every env_file here, from any path (another app's
 * secrets included), and bakes it into the config; unresolved, the allow-list
 * sees env_file and refuses it.
 */
export const config = (app: App, appsDir: string, bundle: Bundle) => typed<Argv>([
  "docker", ...project(app, appsDir, bundle), "config", "--no-env-resolution", "--format", "json",
]);

export const policy = (app: App, script: string, domain: string, bundle: Bundle) =>
  typed<Argv>(["bash", script, app.name, domain, JSON.stringify(wireRoutes(bundle.routes)), ...app.hosts]);

/**
 * The app's files, then the platform's routes. --remove-orphans: a service the
 * app dropped from its compose files must not keep running.
 */
export const up = (app: App, appsDir: string, bundle: Bundle) => typed<Argv>([
  "docker", ...project(app, appsDir, bundle), "-f", routesFile, "up", "-d", "--wait", "--wait-timeout", "180", "--remove-orphans",
]);
