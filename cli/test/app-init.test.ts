import { deepStrictEqual, ok as assert, strictEqual } from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { envFileKeys, exposed, nameFrom, planInit } from "../src/core/app-init/plan.ts";
import { absolutePath, kayraRoot } from "../src/core/fleet/brand.ts";
import { appManifestSchema } from "../src/core/fleet/settings.ts";
import { render } from "../src/core/plan/describe.ts";
import { appInit } from "../src/core/recipes/app-check.ts";
import { must } from "./support.ts";

const root = "/repo/notes";

/** What `docker compose config --no-interpolate --no-env-resolution --format json` gives for a typical project. */
const config = {
  services: {
    web: {
      build: { context: `${root}/web`, dockerfile: "Dockerfile" },
      container_name: "notes-web",
      ports: [{ mode: "ingress", protocol: "tcp", published: "3000", target: 3000 }],
      env_file: [{ path: `${root}/.env`, required: true }],
      environment: { DATABASE_URL: "postgres://notes:${DB_PASSWORD}@db/notes", PORT: "${PORT:-3000}" },
      networks: { default: null },
    },
    db: {
      image: "postgres:16",
      environment: { POSTGRES_PASSWORD: "${DB_PASSWORD:?}" },
      volumes: [
        { type: "bind", source: `${root}/pgdata`, target: "/var/lib/postgresql/data", bind: { create_host_path: true } },
        { type: "bind", source: `${root}/init.sql`, target: "/docker-entrypoint-initdb.d/init.sql" },
      ],
      privileged: true,
      mem_limit: "268435456",
    },
  },
};

const compose = planInit("notes", root, {
  kind: "compose",
  file: "compose.yml",
  config,
  envKeys: (path) => (path === `${root}/.env` ? ["SESSION_SECRET", "LOG_LEVEL"] : undefined),
  isFile: (path) => path.endsWith(".sql"),
});

const written = (path: string) => compose.files.find((file) => file.path === path)?.content ?? "";

test("app init: app.yml lists the project's compose file and the overlay, routes from published ports, values from interpolation and env files", () => {
  const manifest = appManifestSchema.parse(parse(written("app.yml")));
  deepStrictEqual(manifest.compose, ["compose.yml", "kayra/compose.yml"]);
  deepStrictEqual(manifest.routes, [{ host: "web", service: "web", port: 3000 }]);
  deepStrictEqual(manifest.secrets, ["DB_PASSWORD", "SESSION_SECRET"]);
  deepStrictEqual(manifest.config, ["LOG_LEVEL"]);
});

test("app init: a built service becomes an artifact in the app's namespace; its build, ports, env_file and container_name are reset", () => {
  deepStrictEqual(JSON.parse(written("kayra/web/docker/image.json")), { image: "notes/web", dockerfile: "web/Dockerfile", context: "web", inputs: ["web"] });
  const overlay = written("kayra/compose.yml");
  ["image: ${WEB_IMAGE:?}", "build: !reset null", "ports: !reset []", "env_file: !reset []", "container_name: !reset null", "SESSION_SECRET: ${SESSION_SECRET:?}"].forEach((line) => {
    assert(overlay.includes(line), line);
  });
  assert(!overlay.includes("abc"), "env file values are never read");
});

test("app init: a directory bind becomes a named volume, a file bind and refused keys are left to a person", () => {
  const overlay = written("kayra/compose.yml");
  assert(overlay.includes("volumes: !override"));
  assert(overlay.includes("source: db-pgdata"));
  assert(!overlay.includes("init.sql"), "a file bind is dropped from the override, not turned into a volume");
  assert(overlay.includes("db-pgdata: {}"));
  deepStrictEqual(compose.todo, [
    "service web: no healthcheck; a deploy then waits only for it to start",
    "service db: bind mount of the file init.sql → /docker-entrypoint-initdb.d/init.sql; COPY it into the image instead",
    "service db: privileged is not allowed by the compose policy",
  ]);
  assert(compose.did.includes("service db: bind mount pgdata → /var/lib/postgresql/data as the named volume db-pgdata; its data starts empty on the server"));
  assert(!compose.did.some((line) => line.startsWith("service db: mem_limit")), "a service with a memory limit keeps it");
});

test("app init: a context outside the app, build args, an unreadable env file and no published port are said, not guessed", () => {
  const odd = planInit("notes", root, {
    kind: "compose",
    file: "compose.yml",
    config: { services: { api: { build: { context: "/elsewhere", args: { X: "1" } }, env_file: [{ path: `${root}/missing.env` }] } } },
    envKeys: () => undefined,
    isFile: () => false,
  });
  deepStrictEqual(odd.todo, [
    "service api: its build context /elsewhere is outside the app; the build sees only the app's checkout",
    "service api: env_file missing.env could not be read; declare its keys in app.yml",
    "no service publishes a port: add a route to app.yml for the one people reach",
  ]);
});

test("app init: a lone Dockerfile becomes one service, web, on www at the port it EXPOSEs", () => {
  const lone = planInit("notes", root, { kind: "dockerfile", expose: 3000 });
  deepStrictEqual(appManifestSchema.parse(parse(lone.files[0]?.content ?? "")).routes, [{ host: "www", service: "web", port: 3000 }]);
  deepStrictEqual(lone.files.map((file) => file.path), ["app.yml", "kayra/compose.yml", "kayra/web/docker/image.json"]);
  assert(planInit("notes", root, { kind: "dockerfile", expose: undefined }).todo[0]?.includes("assumed 8080"));
});

test("app init: names, exposed ports and env file keys", () => {
  strictEqual(nameFrom("My_Notes App"), "my-notes-app");
  strictEqual(nameFrom("2048"), undefined);
  strictEqual(exposed("FROM node\nexpose 3000/tcp\nEXPOSE 9000\n"), 3000);
  strictEqual(exposed("FROM node\n"), undefined);
  deepStrictEqual(envFileKeys("# comment\nexport A=1\nB = two\n\nnot a line\n"), ["A", "B"]);
});

test("app init: the tools, the writer, then the same check as app check", () => {
  const plan = appInit(kayraRoot(must(absolutePath("/kayra"))), must(absolutePath("/repo")), "shop");
  deepStrictEqual(render(plan).slice(-2), [
    `run      ${process.execPath} /kayra/bin/kayra-app-init.js '{"root":"/repo","name":"shop"}'`,
    "run      bash /kayra/scripts/local/app-check.sh /repo",
  ]);
});

const dockerAvailable = spawnSync("docker", ["compose", "version"], { stdio: "ignore" }).status === 0;
test("app init: the helper writes a real project's files once, and refuses a second time", { skip: !dockerAvailable }, () => {
  const project = mkdtempSync(join(tmpdir(), "kayra-init-"));
  try {
    mkdirSync(join(project, "web"));
    writeFileSync(join(project, "web", "Dockerfile"), "FROM nginx:alpine\nEXPOSE 80\n");
    writeFileSync(join(project, "compose.yaml"), "services:\n  web:\n    build: ./web\n    ports: ['8000:80']\n");
    const helper = join(import.meta.dirname, "../../bin/kayra-app-init.js");
    const first = spawnSync(process.execPath, [helper, JSON.stringify({ root: project, name: "site" })], { encoding: "utf8" });
    strictEqual(first.status, 0, first.stderr);
    deepStrictEqual(appManifestSchema.parse(parse(readFileSync(join(project, "app.yml"), "utf8"))).routes, [{ host: "web", service: "web", port: 80 }]);
    const again = spawnSync(process.execPath, [helper, JSON.stringify({ root: project, name: "site" })], { encoding: "utf8" });
    strictEqual(again.status, 1);
    assert(again.stderr.includes("app.yml exists already"));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
