import type { App } from "./app.ts";
import type { Bundle } from "./bundle.ts";

export type Argv = readonly [string, ...string[]];

/**
 * The app's compose project, run in the run's directory: its .env from the
 * platform (operator config), the image refs from this run, the compose files
 * from the commit being deployed. Never COMPOSE_PROJECT_NAME from the
 * environment: -p names the project.
 */
const project = (app: App, appsDir: string, bundle: Bundle): readonly string[] => {
  const dir = `${appsDir}/${app.name}`;
  return [
    "compose", "-p", app.name, "--project-directory", dir, "--env-file", `${dir}/.env`, "--env-file", "images.env",
    ...bundle.compose.flatMap((file) => ["-f", file.path]),
  ];
};

/**
 * What admission checks. --no-env-resolution: otherwise compose reads every
 * env_file here, from any path (another app's secrets included), and bakes it
 * into the config; unresolved, the allow-list sees env_file and refuses it.
 */
export const config = (app: App, appsDir: string, bundle: Bundle): Argv => [
  "docker", ...project(app, appsDir, bundle), "config", "--no-env-resolution", "--format", "json",
];

export const policy = (app: App, script: string): Argv => ["bash", script, app.name, ...app.hosts];

/** --remove-orphans: a service the app dropped from its compose files must not keep running. */
export const up = (app: App, appsDir: string, bundle: Bundle): Argv => [
  "docker", ...project(app, appsDir, bundle), "up", "-d", "--wait", "--wait-timeout", "180", "--remove-orphans",
];
