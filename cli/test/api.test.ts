import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { absolutePath, fleetRoot, kayraRoot, kayraVersion, remotePath } from "../src/core/fleet/brand.ts";
import { operation, operationNames, type OperationName } from "../src/core/operations/catalog.ts";
import { ok } from "../src/lib/result.ts";
import { admit, cookieName } from "../src/clients/api/auth.ts";
import { openapi } from "../src/clients/api/openapi.ts";
import { contractTypes } from "../src/clients/wire/contract.ts";
import { busy, readRecord, recordLine, runId, stateOf } from "../src/clients/api/runs.ts";
import { serve, type Clients } from "../src/serve.ts";
import { schemas } from "../src/clients/wire/schemas.ts";
import { apiReference } from "../scripts/api-reference.ts";
import type { RunEvent } from "../src/clients/wire/contract.gen.ts";
import { must, server } from "./support.ts";

type Answer = { readonly status: number; readonly headers: Readonly<Record<string, string | string[] | undefined>>; readonly body: string };
type Sent = { readonly method?: string; readonly cookie?: string; readonly token?: string; readonly host?: string; readonly origin?: string; readonly body?: unknown; readonly accept?: string };
const call = (port: number, path: string, options: Sent = {}): Promise<Answer> => new Promise((resolve, reject) => {
  const sent = request({ host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: {
    host: options.host ?? `127.0.0.1:${String(port)}`,
    ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    ...(options.accept === undefined ? {} : { accept: options.accept }),
    ...(options.body === undefined ? {} : { "content-type": "application/json" }),
  } }, (response) => {
    // eslint-disable-next-line functional/prefer-immutable-types -- collect this HTTP response
    const state: { text: string } = { text: "" };
    response.setEncoding("utf8");
    // eslint-disable-next-line functional/immutable-data -- collect response bytes
    response.on("data", (chunk: string) => { state.text += chunk; });
    response.on("end", () => { resolve({ status: response.statusCode ?? 0, headers: response.headers, body: state.text }); });
  });
  sent.on("error", reject);
  sent.end(options.body === undefined ? undefined : JSON.stringify(options.body));
});
const object = (answer: Answer) => z.record(z.string(), z.unknown()).parse(JSON.parse(answer.body));
const idOf = (answer: Answer): string => z.string().parse(object(answer)[answer.status === 201 ? "session" : "run"]);

const fixture = async (clients: Clients = { ui: true, api: true }) => {
  const dir = mkdtempSync(join(tmpdir(), "kayra-api-"));
  const engine = join(dir, "engine");
  const bin = join(dir, "bin");
  const path = process.env["PATH"];
  mkdirSync(join(engine, "scripts/local"), { recursive: true });
  mkdirSync(bin);
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "app/app.yml"), "name: shop\ncompose: [deploy/compose.yml]\n");
  ["require-main.sh", "require-latest-state.sh", "home-reach.sh", "certs.sh", "app-check.sh"].forEach((name) => { writeFileSync(join(engine, "scripts/local", name), "exit 0\n"); });
  const program = (name: string, text: string): void => { writeFileSync(join(bin, name), `#!/bin/sh\n${text}\n`, { mode: 0o700 }); };
  program("ansible-galaxy", "exit 0");
  program("ansible-playbook", '[ -z "$ANSIBLE_VAULT_PASSWORD_FILE" ] || [ "$("$ANSIBLE_VAULT_PASSWORD_FILE")" = test-api-password ] || exit 7\necho "playbook finished"');
  program("tofu", 'case "$*" in *output*) echo 192.0.2.1;; *state*) echo hcloud_server.this;; esac');
  program("ssh", `case "$*" in
    *'ctl runs'*) echo '{"app":"shop","runs":[]}' ;;
    *'ctl rollback'*) echo '{"app":"shop","releases":[]}' ;;
    *'ctl log'*) echo 'a test log' ;;
    *wait*) exec sleep 30 ;;
    *) echo READY; read -r line; printf 'answer:%s\\n' "$line" ;;
  esac`);
  const lab = { ...server("lab", "target: multipass\ndomain: lab.test\nvault: false\napps: [{name: shop, repo: https://git.example/shop.git}]", { secrets: "a: b\n" }), backupDir: must(remotePath("/backup")) };
  const prod = server("prod", "kind: edge\ntarget: hetzner\ndomain: prod.example\nvault: true");
  const fleet = { root: fleetRoot(must(absolutePath(dir))), servers: [lab, prod] };
  const config = { kayra: kayraRoot(must(absolutePath(engine))), fleet, version: must(kayraVersion("0.0.0-test")), short: (text: string) => text, network: {
    connect: () => Promise.resolve({ kind: "skipped" as const }), get: () => Promise.resolve({ kind: "skipped" as const }),
  }, tofu: { state: () => Promise.resolve(ok([])), output: () => Promise.resolve(undefined) } };
  // eslint-disable-next-line functional/immutable-data -- all subprocesses use fixture programs, never real infrastructure tools
  process.env["PATH"] = `${bin}:${path ?? ""}`;
  const ui = await serve(config, undefined, 0, clients);
  const discovery = ui.discovery === undefined ? undefined : z.object({ token: z.string(), url: z.string(), pid: z.number() }).parse(JSON.parse(readFileSync(ui.discovery, "utf8")));
  const login = clients.ui ? await call(ui.port, new URL(ui.url).pathname + new URL(ui.url).search) : undefined;
  const cookie = String(login?.headers["set-cookie"] ?? "").split(";")[0] ?? "";
  const origin = `http://127.0.0.1:${String(ui.port)}`;
  return { ...ui, dir, bin, config, token: discovery?.token ?? "", cookie, origin, discoveryEntry: discovery,
    post: (name: string, input: unknown = {}, extra: Readonly<Record<string, unknown>> = {}) => call(ui.port, `/api/operations/${name}`, { method: "POST", token: discovery?.token ?? "", body: { input, ...extra } }),
    cleanup: async () => {
      await ui.close();
      // eslint-disable-next-line functional/immutable-data -- restore the operator's environment
      if (path === undefined) delete process.env["PATH"]; else process.env["PATH"] = path;
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

test("admission: exact Host for everyone, bearer or cookie token, Origin only for cookie writes", () => {
  const asked = { method: "POST", path: "/api/operations/version", host: "127.0.0.1:7700", origin: undefined, cookie: undefined, authorization: "Bearer token" };
  const enabled = { api: true, ui: true };
  deepStrictEqual(admit(asked, 7700, "token", enabled), { admitted: true });
  strictEqual(admit({ ...asked, host: "rebound.example" }, 7700, "token", enabled).admitted, false);
  strictEqual(admit({ ...asked, authorization: "Bearer wrong" }, 7700, "token", enabled).admitted, false);
  strictEqual(admit(asked, 7700, "token", { ui: true, api: false }).admitted, false);
  const cookie = { ...asked, authorization: undefined, cookie: `${cookieName(7700)}=token` };
  strictEqual(admit(cookie, 7700, "token", enabled).admitted, false);
  strictEqual(admit({ ...cookie, origin: "http://evil.example" }, 7700, "token", enabled).admitted, false);
  strictEqual(admit({ ...cookie, origin: "http://localhost:7700" }, 7700, "token", enabled).admitted, false);
  deepStrictEqual(admit({ ...cookie, origin: "http://127.0.0.1:7700" }, 7700, "token", enabled), { admitted: true });
  strictEqual(admit({ ...cookie, method: "GET" }, 7700, "token", { api: true, ui: false }).admitted, false);
});

test("generated browser types, OpenAPI and API reference match the catalog and protocol schemas", () => {
  const clients = join(import.meta.dirname, "../src/clients");
  const version = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"))).version;
  strictEqual(readFileSync(join(clients, "wire", "contract.gen.ts"), "utf8"), contractTypes());
  strictEqual(readFileSync(join(clients, "api", "openapi.json"), "utf8"), `${JSON.stringify(openapi(version), null, 2)}\n`);
  strictEqual(readFileSync(join(import.meta.dirname, "../../site/src/content/docs/reference/api.md"), "utf8"), apiReference(openapi(version)));
});

test("run records retain their history and session identity, and only live runs lock a server", () => {
  strictEqual(runId("2026-10-18T20:15:02.123Z", "a1b2c3"), "20261018T201502Z-a1b2c3");
  const text = recordLine({ id: "r1", command: "kayra setup lab", server: "lab", started: "now", session: false }) + recordLine({ kind: "started", index: 0 });
  const run = readRecord(text + "{partial");
  if (run === undefined) throw new Error("no record");
  strictEqual(run.session, false);
  strictEqual(stateOf(run.events), "running");
  strictEqual(busy([run], "lab"), true);
  strictEqual(busy([run], "prod"), false);
  strictEqual(stateOf([{ kind: "ended", failures: 0, ms: 1, footer: [] }]), "passed");
});

const samples = {
  up: { server: "lab" }, provision: { server: "lab" }, deploy: { server: "lab" }, setup: { server: "lab" }, plan: { server: "lab" }, verify: { server: "lab" }, apps: { server: "lab" }, hosts: { server: "lab" },
  down: { server: "lab" }, adopt: { server: "prod" }, "backup.test": { server: "lab" }, ssh: { server: "lab" }, "ssh.exec": { server: "lab", command: ["uptime"] },
  "app.check": { dir: "app" }, "app.purge": { server: "lab", app: "shop" }, "app.runs": { server: "lab", app: "shop" }, "app.log": { server: "lab", app: "shop" }, "app.releases": { server: "lab", app: "shop" },
  "app.deploy": { server: "lab", app: "shop" }, "app.rollback": { server: "lab", app: "shop", sha: "0123abc" }, job: { server: "lab", job: "gc" },
  certs: { domain: "fixture.test" }, doctor: {}, validate: {}, status: { offline: true }, version: {},
} satisfies Readonly<Record<OperationName, unknown>>;

test("every catalog operation is previewed or queried over HTTP; unknown operations and invalid inputs are refused", async (t) => {
  const api = await fixture(); t.after(api.cleanup);
  const metadata = await call(api.port, "/api/operations", { token: api.token });
  const catalog = z.array(schemas.OperationInfo).parse(JSON.parse(metadata.body));
  deepStrictEqual(catalog.map((item) => item.name), operationNames);
  for (const name of operationNames) {
    const { kind } = operation(name);
    const preview = kind === "plan" || kind === "session";
    const result = await api.post(`${name}${preview ? "/preview" : ""}`, samples[name]);
    strictEqual(result.status, 200, `${name}: ${result.body}`);
    if (preview) strictEqual(schemas.Preview.safeParse(JSON.parse(result.body)).success, true, name);
    else if (name === "status") strictEqual(schemas.Status.safeParse(JSON.parse(result.body.split("\n\n")[0]?.slice(6) ?? "")).success, true);
  }
  const spec = object(await call(api.port, "/api/openapi.json", { token: api.token }));
  strictEqual(spec["openapi"], "3.1.0");
  strictEqual(JSON.stringify(spec).includes('/api/v1'), false);
  strictEqual((await api.post("toString")).status, 404);
  strictEqual((await api.post("setup", { server: "missing" })).status, 400);
  strictEqual((await api.post("setup", { server: "lab", unexpected: true })).status, 400);
  strictEqual((await api.post("ssh.exec", { server: "lab", command: [] })).status, 400);
  strictEqual((await api.post("doctor", {}, { options: { columns: "120; evil" } })).status, 400);
  const verbose = await api.post("setup/preview", { server: "lab" }, { options: { verbose: true } });
  strictEqual(verbose.body.includes("ANSIBLE_STDOUT_CALLBACK=default"), true);
  const dry = await api.post("down", { server: "prod" }, { options: { dryRun: true } });
  strictEqual(dry.status, 200);
});

test("discovery is private, removed on close, refuses a second API owner, and UI-only mode writes no API token", async (t) => {
  const api = await fixture(); t.after(api.cleanup);
  if (api.discovery === undefined) throw new Error("no discovery file");
  strictEqual(statSync(api.discovery).mode & 0o777, 0o600);
  strictEqual(api.discoveryEntry?.url, `http://127.0.0.1:${String(api.port)}/api`);
  strictEqual(api.discoveryEntry.pid, process.pid);
  await rejects(serve(api.config, undefined, 0, { api: true, ui: false }), /already discoverable/);
  await api.close();
  strictEqual(existsSync(api.discovery), false);
  const browser = await serve(api.config, undefined, 0, { api: false, ui: true });
  try { strictEqual(browser.discovery, undefined); strictEqual(existsSync(api.discovery), false); } finally { await browser.close(); }
});

test("the authenticated directory picker returns local directories, follows directory links and never returns file contents", async (t) => {
  const api = await fixture(); t.after(api.cleanup);
  const repo = join(api.dir, "repository with spaces");
  mkdirSync(repo);
  symlinkSync(repo, join(api.dir, "linked-repo"));
  writeFileSync(join(api.dir, "secret.txt"), "private-value");
  strictEqual((await call(api.port, "/api/directories")).status, 401);
  const result = await call(api.port, "/api/directories", { token: api.token });
  const listing = schemas.DirectoryListing.parse(JSON.parse(result.body));
  strictEqual(listing.directories.some((entry) => entry.name === "secret.txt"), false);
  strictEqual(listing.directories.some((entry) => entry.name === "linked-repo"), true);
  strictEqual(result.body.includes("private-value"), false);
  const chosen = schemas.DirectoryListing.parse(JSON.parse((await call(api.port, `/api/directories?path=${encodeURIComponent(repo)}`, { token: api.token })).body));
  strictEqual(chosen.path.endsWith("/repository with spaces"), true);
  strictEqual(chosen.parent, listing.path);
  strictEqual((await call(api.port, "/api/directories?path=secret.txt", { token: api.token })).status, 400);
  strictEqual((await call(api.port, "/api/directories?path=missing", { token: api.token })).status, 400);
});

test("HTTP auth refuses missing/wrong tokens, rebinding and cookie CSRF; API-only mode serves no browser", async (t) => {
  const api = await fixture({ api: true, ui: false }); t.after(api.cleanup);
  strictEqual((await call(api.port, "/api/fleet")).status, 401);
  strictEqual((await call(api.port, "/api/fleet", { token: "wrong" })).status, 401);
  strictEqual((await call(api.port, "/api/fleet", { token: api.token, host: "evil.example" })).status, 403);
  strictEqual((await call(api.port, "/", { token: api.token })).status, 404);
  strictEqual((await call(api.port, "/login?token=anything", { token: api.token })).status, 404);
  strictEqual((await api.post("version")).status, 200);
});

const follow = (port: number, path: string, token: string, each: (event: RunEvent) => Promise<unknown>): Promise<readonly RunEvent[]> => new Promise((resolve, reject) => {
  const sent = request({ host: "127.0.0.1", port, path, headers: { authorization: `Bearer ${token}` } }, (response) => {
    // eslint-disable-next-line functional/prefer-immutable-types -- parse arbitrarily split SSE frames
    const state: { pending: string; events: RunEvent[] } = { pending: "", events: [] };
    response.setEncoding("utf8");
    response.on("data", (chunk: string) => {
      const frames = (state.pending + chunk).split("\n\n");
      // eslint-disable-next-line functional/immutable-data -- retain the incomplete frame
      state.pending = frames.pop() ?? "";
      frames.filter((frame) => frame.startsWith("data: ")).forEach((frame) => {
        const event = schemas.RunEvent.parse(JSON.parse(frame.slice(6)));
        // eslint-disable-next-line functional/immutable-data -- retain events for assertions
        state.events.push(event);
        void each(event).catch(reject);
      });
    });
    response.on("end", () => { resolve(state.events); });
    response.on("error", reject);
  });
  sent.on("error", reject); sent.end();
});

test("real changes require the server name; secrets can be answered or cancelled without entering SSE or records", { timeout: 10_000 }, async (t) => {
  const api = await fixture(); t.after(api.cleanup);
  strictEqual((await api.post("setup", { server: "prod" })).status, 403);
  const id = idOf(await api.post("setup", { server: "prod" }, { confirm: "prod" }));
  const events = await follow(api.port, `/api/runs/${id}/events`, api.token, async (event) => {
    if (event.kind === "ask") {
      strictEqual(event.secret, true);
      strictEqual((await call(api.port, `/api/runs/${id}/answers`, { method: "POST", token: api.token, body: { text: "test-api-password" } })).status, 204);
    }
  });
  strictEqual(events.some((event) => event.kind === "ended" && event.failures === 0), true);
  strictEqual(JSON.stringify(events).includes("test-api-password"), false);
  const second = idOf(await api.post("setup", { server: "prod" }, { confirm: "prod" }));
  const cancelled = await follow(api.port, `/api/runs/${second}/events`, api.token, async (event) => {
    if (event.kind === "ask") strictEqual((await call(api.port, `/api/runs/${second}/cancel`, { method: "POST", token: api.token })).status, 204);
  });
  strictEqual(cancelled.some((event) => event.kind === "ended" && event.stop?.why === "interrupted"), true);
  strictEqual((await call(api.port, `/api/runs/${second}/answers`, { method: "POST", token: api.token, body: { text: "late-password" } })).status, 404);
  const records = join(api.dir, ".cache/ui/runs");
  const recorded = readdirSync(records).map((file) => readFileSync(join(records, file), "utf8")).join("\n");
  strictEqual(recorded.includes("test-api-password"), false);
  strictEqual(recorded.includes("late-password"), false);
  const replay = await call(api.port, `/api/runs/${id}/events`, { token: api.token, accept: "application/x-ndjson" });
  deepStrictEqual(replay.body.trim().split("\n").map((line) => schemas.RunEvent.parse(JSON.parse(line))), events);
  strictEqual(schemas.Run.safeParse(object(await call(api.port, `/api/runs/${id}`, { token: api.token }))).success, true);
});

test("locks are per server; terminal sessions accept live input and end cleanly", { timeout: 10_000 }, async (t) => {
  const api = await fixture(); t.after(api.cleanup);
  const waiting = idOf(await api.post("ssh.exec", { server: "lab", command: ["wait"] }));
  strictEqual((await api.post("setup", { server: "lab" })).status, 409);
  const other = idOf(await api.post("setup", { server: "prod" }, { confirm: "prod" }));
  strictEqual((await call(api.port, `/api/runs/${waiting}/cancel`, { method: "POST", token: api.token })).status, 204);
  await call(api.port, `/api/runs/${waiting}/events`, { token: api.token });
  await call(api.port, `/api/runs/${other}/cancel`, { method: "POST", token: api.token });
  const started = await api.post("ssh", { server: "lab" }, { options: { rows: 23, columns: 80 } });
  strictEqual(started.status, 201);
  const session = idOf(started);
  const events = await follow(api.port, `/api/sessions/${session}/output`, api.token, async (event) => {
    if (event.kind === "output" && event.chunk.includes("READY")) strictEqual((await call(api.port, `/api/sessions/${session}/input`, { method: "POST", token: api.token, body: { text: "hello\n" } })).status, 204);
  });
  strictEqual(events.some((event) => event.kind === "output" && event.chunk.includes("answer:hello")), true);
  strictEqual(events.some((event) => event.kind === "ended" && event.failures === 0), true);
  strictEqual((await call(api.port, `/api/sessions/${session}/input`, { method: "POST", token: api.token, body: { text: "late" } })).status, 404);
});


test("cookie login uses HttpOnly/SameSite and HTTP writes require the exact Origin", async (t) => {
  const api = await fixture(); t.after(api.cleanup);
  const token = new URL(api.url).searchParams.get("token") ?? "";
  const login = await call(api.port, `/login?token=${token}`);
  strictEqual(String(login.headers["set-cookie"]).includes("HttpOnly; SameSite=Strict"), true);
  const options = { method: "POST", cookie: api.cookie, body: { input: {} } };
  strictEqual((await call(api.port, "/api/operations/version", options)).status, 403);
  strictEqual((await call(api.port, "/api/operations/version", { ...options, origin: "https://evil.example" })).status, 403);
  strictEqual((await call(api.port, "/api/operations/version", { ...options, origin: api.origin })).status, 200);
  strictEqual(Buffer.from(api.token, "base64url").length, 32);
});

test("a terminal session can be closed through DELETE, and stale discovery is replaced safely", { timeout: 10_000 }, async (t) => {
  const api = await fixture(); t.after(api.cleanup);
  const session = idOf(await api.post("ssh", { server: "lab" }));
  const events = await follow(api.port, `/api/sessions/${session}/output`, api.token, async (event) => {
    if (event.kind === "output" && event.chunk.includes("READY")) strictEqual((await call(api.port, `/api/sessions/${session}`, { method: "DELETE", token: api.token })).status, 204);
  });
  strictEqual(events.some((event) => event.kind === "ended" && event.stop?.why === "interrupted"), true);
  await api.close();
  if (api.discovery === undefined) throw new Error("no discovery file");
  writeFileSync(api.discovery, JSON.stringify({ url: "http://127.0.0.1:1/api", token: "old", pid: 2147483647 }), { mode: 0o644 });
  const restarted = await serve(api.config, undefined, 0, { api: true, ui: false });
  try {
    strictEqual(statSync(api.discovery).mode & 0o777, 0o600);
    strictEqual(readFileSync(api.discovery, "utf8").includes('"token":"old"'), false);
  } finally { await restarted.close(); }
});


test("shutdown cancels an in-flight SSH query and waits for its child to exit", { timeout: 5_000 }, async (t) => {
  const api = await fixture(); t.after(api.cleanup);
  const marker = join(api.dir, "query.pid");
  writeFileSync(join(api.bin, "ssh"), `#!/bin/sh\necho $$ > '${marker}'\nexec sleep 30\n`, { mode: 0o700 });
  const request = api.post("app.runs", { server: "lab", app: "shop" }).then(() => undefined, () => undefined);
  const ready = async (attempts: number): Promise<void> => {
    if (existsSync(marker)) return;
    if (attempts === 0) throw new Error("the query never started");
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    await ready(attempts - 1);
  };
  await ready(100);
  const pid = Number(readFileSync(marker, "utf8").trim());
  await api.close();
  await request;
  const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  strictEqual(alive(), false);
});
