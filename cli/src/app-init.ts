import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { envFileKeys, exposed, nameFrom, overlayFile, planInit, type Source } from "./core/app-init/plan.ts";
import { names } from "./lib/names.ts";
import { err, ok, type Result } from "./lib/result.ts";

/** The compose file a project deploys with, as Compose itself looks for it. */
const composeNames = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

const input = z.strictObject({ root: z.string().min(1), name: z.string().optional() });

const keysOf = (path: string) => {
  try {
    return envFileKeys(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

const sourceOf = (root: string, name: string): Result<Source, string> => {
  const file = composeNames.find((each) => existsSync(join(root, each)));
  if (file !== undefined) {
    const config = spawnSync("docker", ["compose", "-p", name, "-f", file, "config", "--no-interpolate", "--no-env-resolution", "--format", "json"], { cwd: root, encoding: "utf8" });
    if (config.status !== 0) return err(`docker compose cannot read ${file}: ${config.stderr.trim()}`);
    const parsed: unknown = JSON.parse(config.stdout);
    return ok<Source>({ kind: "compose", file, config: parsed, envKeys: keysOf, isFile: (path) => existsSync(path) && statSync(path).isFile() });
  }
  if (existsSync(join(root, "Dockerfile"))) return ok<Source>({ kind: "dockerfile", expose: exposed(readFileSync(join(root, "Dockerfile"), "utf8")) });
  return err(`no ${composeNames.join(", ")} or Dockerfile in ${root}`);
};

const run = () => {
  const request = input.safeParse(JSON.parse(process.argv[2] ?? "null"));
  if (!request.success) return err("invalid app init request");
  const { root } = request.data;
  const name = request.data.name ?? nameFrom(basename(root));
  if (name === undefined || !names.app.pattern.test(name)) return err(`no app name from ${basename(root)}: give one with --name (${names.app.what})`);
  if (existsSync(join(root, "app.yml"))) return err("app.yml exists already: this project has its app contract; kayra app check checks it");
  if (existsSync(join(root, dirname(overlayFile)))) return err(`${dirname(overlayFile)}/ exists already; move it away to start over`);
  const source = sourceOf(root, name);
  if (!source.ok) return source;
  const init = planInit(name, root, source.value);
  init.files.forEach((file) => {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), file.content, { flag: "wx" });
  });
  return ok(Object.freeze([
    `${name}: wrote ${init.files.map((file) => file.path).join(", ")}`,
    ...init.did.map((line) => `✓ ${line}`),
    ...init.todo.map((line) => `! ${line}`),
  ]));
};

const result = run();
if (result.ok) process.stdout.write(`${result.value.join("\n")}\n`);
else {
  process.stderr.write(`${result.error}\n`);
  // eslint-disable-next-line functional/immutable-data -- exit after flushing diagnostics
  process.exitCode = 1;
}
