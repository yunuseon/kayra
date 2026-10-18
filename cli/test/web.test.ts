import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { z } from "zod";
import { absolutePath, fleetRoot, kayraRoot } from "../src/core/brand.ts";
import type { Network } from "../src/core/commands/status.ts";
import { admit, cookieName } from "../src/clients/api/auth.ts";
import { changes, commandInput, offered, toInvocation, words } from "../src/clients/api/commands.ts";
import { opentofu } from "../src/core/commands/status.ts";
import { isPlan, planOf } from "../src/core/operations/run.ts";
import type { RunEvent } from "../src/clients/api/contract.ts";
import { busy, readRecord, recordLine, runId, stateOf } from "../src/clients/api/runs.ts";
import { serve } from "../src/serve.ts";
import { must, root, server } from "./support.ts";

const prod = server("prod", "target: hetzner\ndomain: prod.example\nvault: true\nvault_password_file: /pass\napps: [{name: shop, repo: https://git.example/shop.git}]");
const lab = server("lab", "target: multipass\ndomain: lab.test\nvault: true\nvault_password_file: /pass", { secrets: "a: b\n" });

test("admission: this listener's host always, its origin for a write, the token for the API", () => {
  const asked = { method: "GET", path: "/api/fleet", host: "127.0.0.1:7700", origin: undefined, cookie: `${cookieName(7700)}=t0k` };
  deepStrictEqual(admit(asked, 7700, "t0k"), { admitted: true });
  deepStrictEqual(admit({ ...asked, host: "evil.example:7700" }, 7700, "t0k").admitted, false);
  deepStrictEqual(admit({ ...asked, cookie: undefined }, 7700, "t0k"), { admitted: false, status: 401, why: "no token: open the URL kayra ui printed" });
  deepStrictEqual(admit({ ...asked, cookie: `${cookieName(7701)}=t0k` }, 7700, "t0k").admitted, false);
  deepStrictEqual(admit({ ...asked, method: "POST", origin: "http://evil.example" }, 7700, "t0k").admitted, false);
  deepStrictEqual(admit({ ...asked, method: "POST", origin: "http://localhost:7700" }, 7700, "t0k"), { admitted: true });
  deepStrictEqual(admit({ ...asked, path: "/assets/app.js", cookie: undefined }, 7700, "t0k"), { admitted: true });
});

test("commands: the browser's command as the catalog's operation, checked against the fleet when planned, said as typed, offered by kind", () => {
  const fleet = { root, servers: [prod, lab] };
  const context = {
    engine: { kayra: kayraRoot(must(absolutePath("/kayra"))), fleet: root },
    fleet,
    version: "9.9.9",
    here: root,
    read: () => undefined,
    network: { connect: () => Promise.resolve({ kind: "skipped" as const }), get: () => Promise.resolve({ kind: "skipped" as const }) },
    tofu: opentofu,
  };
  const planned = (input: Parameters<typeof toInvocation>[0]): boolean => {
    const call = toInvocation(input);
    return call.ok && isPlan(call.value) && planOf(context, call.value).ok;
  };
  deepStrictEqual(must(toInvocation({ name: "deploy", server: "prod" })), { name: "deploy", input: { server: "prod" } });
  deepStrictEqual(must(toInvocation({ name: "app rollback", server: "prod", app: "shop", sha: "0123abc" })), {
    name: "app.rollback",
    input: { server: "prod", app: "shop", sha: "0123abc" },
  });
  strictEqual(planned({ name: "deploy", server: "prod" }), true);
  strictEqual(planned({ name: "deploy", server: "nope" }), false);
  // A removed app's volumes are what purge is for: it need not be in server.yml.
  strictEqual(planned({ name: "app purge", server: "prod", app: "other" }), true);
  strictEqual(planned({ name: "app purge", server: "prod", app: "Not-An-App" }), false);
  strictEqual(commandInput.safeParse({ name: "ssh", server: "prod" }).success, false);
  strictEqual(commandInput.safeParse({ name: "app rollback", server: "prod", app: "shop", sha: "main" }).success, false);
  strictEqual(words({ name: "job", server: "prod", job: "renovate", noPrs: true }), "kayra job prod renovate --no-prs");
  strictEqual(changes({ name: "plan", server: "prod" }), false);
  strictEqual(changes({ name: "deploy", server: "prod" }), true);
  deepStrictEqual(offered(prod), ["deploy", "apps", "verify", "setup", "plan", "provision", "job", "adopt", "down"]);
  deepStrictEqual(offered(lab), ["deploy", "apps", "verify", "setup", "plan", "up", "provision", "job", "down"]);
});

test("runs: a record read back, its state from its last event, one run per server", () => {
  strictEqual(runId("2026-10-18T20:15:02.123Z", "a1b2c3"), "20261018T201502Z-a1b2c3");
  const ended: RunEvent = { kind: "ended", failures: 0, ms: 5, footer: [] };
  const text = [recordLine({ id: "r1", command: "kayra deploy lab", server: "lab", started: "now" }), recordLine({ kind: "started", index: 0 }), "{broken\n"].join("");
  const run = readRecord(text);
  deepStrictEqual(run, { id: "r1", command: "kayra deploy lab", server: "lab", started: "now", events: [{ kind: "started", index: 0 }] });
  strictEqual(stateOf(run.events), "running");
  strictEqual(stateOf([ended]), "passed");
  strictEqual(stateOf([{ ...ended, stop: { index: 0, why: "interrupted" } }]), "interrupted");
  strictEqual(busy([run], "lab"), true);
  strictEqual(busy([run], "prod"), false);
});

// The server, end to end: a fleet in a temp dir (runs are recorded under it), a network that answers nothing.
const dir = mkdtempSync(join(tmpdir(), "kayra-ui-"));
after(() => {
  rmSync(dir, { recursive: true, force: true });
});
const quiet: Network = { connect: () => Promise.resolve({ kind: "skipped" }), get: () => Promise.resolve({ kind: "skipped" }) };

type Answer = { readonly status: number; readonly headers: Readonly<Record<string, string | string[] | undefined>>; readonly body: string };

const call = (port: number, path: string, options: { readonly method?: string; readonly cookie?: string; readonly host?: string; readonly origin?: string; readonly body?: unknown } = {}) =>
  new Promise<Answer>((resolve, reject) => {
    const sent = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: {
          host: options.host ?? `127.0.0.1:${String(port)}`,
          ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
          ...(options.origin === undefined ? {} : { origin: options.origin }),
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
        },
      },
      (response) => {
        // eslint-disable-next-line functional/prefer-immutable-types -- collecting the body
        const chunks: Buffer[] = [];
        // eslint-disable-next-line functional/immutable-data, functional/prefer-immutable-types -- collecting the body, Node's Buffers
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    sent.on("error", reject);
    sent.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });

test("kayra ui: in only with this launch's token, a preview of any command, a real server's change only confirmed, a run's events to its end", async () => {
  const fleet = { root: fleetRoot(must(absolutePath(dir))), servers: [prod, lab] };
  const ui = await serve({ kayra: kayraRoot(must(absolutePath("/kayra"))), fleet, version: "9.9.9", short: (text) => text, network: quiet }, undefined, 0);
  try {
    const { port } = ui;
    const token = new URL(ui.url).searchParams.get("token") ?? "";
    strictEqual((await call(port, "/api/fleet")).status, 401);
    strictEqual((await call(port, "/login?token=wrong")).status, 401);
    const login = await call(port, `/login?token=${token}`);
    strictEqual(login.status, 303);
    const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    strictEqual((await call(port, "/api/fleet", { cookie, host: "rebound.example" })).status, 403);
    const facts = z.object({ servers: z.array(z.object({ name: z.string() })) }).parse(JSON.parse((await call(port, "/api/fleet", { cookie })).body));
    deepStrictEqual(facts.servers.map((each) => each.name), ["prod", "lab"]);

    const origin = `http://127.0.0.1:${String(port)}`;
    strictEqual((await call(port, "/api/plan", { method: "POST", cookie, origin: "http://evil.example", body: { name: "deploy", server: "lab" } })).status, 403);
    const preview = z
      .object({ invocation: z.object({ command: z.string() }), steps: z.array(z.object({ opens: z.string().optional() })), changes: z.boolean() })
      .parse(JSON.parse((await call(port, "/api/plan", { method: "POST", cookie, origin, body: { name: "deploy", server: "lab" } })).body));
    strictEqual(preview.invocation.command, "kayra deploy lab");
    strictEqual(preview.changes, true);
    deepStrictEqual(preview.steps.flatMap((step) => (step.opens === undefined ? [] : [step.opens])), ["setup", "apps", "verify"]);

    const unconfirmed = await call(port, "/api/runs", { method: "POST", cookie, origin, body: { command: { name: "deploy", server: "prod" } } });
    deepStrictEqual([unconfirmed.status, unconfirmed.body], [403, "this changes prod: confirm with its name\n"]);

    const started = await call(port, "/api/runs", { method: "POST", cookie, origin, body: { command: { name: "doctor" } } });
    strictEqual(started.status, 201);
    const { id } = z.object({ id: z.string() }).parse(JSON.parse(started.body));
    const events = (await call(port, `/api/runs/${id}/events`, { cookie })).body
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => z.object({ kind: z.string() }).parse(JSON.parse(chunk.slice("data: ".length))));
    strictEqual(events[0]?.kind, "plan");
    strictEqual(events.at(-1)?.kind, "ended");
    strictEqual(events.some((event) => event.kind === "said"), true);
    const listed = z.array(z.object({ id: z.string() })).parse(JSON.parse((await call(port, "/api/runs", { cookie })).body));
    strictEqual(listed[0]?.id, id);
  } finally {
    await ui.close();
  }
});


const followRun = (port: number, id: string, cookie: string, question: (secret: boolean) => Promise<unknown>): Promise<string> =>
  new Promise((resolve, reject) => {
    const sent = request({ host: "127.0.0.1", port, path: `/api/runs/${id}/events`, headers: { cookie } }, (response) => {
      // eslint-disable-next-line functional/prefer-immutable-types -- SSE chunks may split a JSON event anywhere
      const received: { text: string; pending: string } = { text: "", pending: "" };
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        // eslint-disable-next-line functional/immutable-data -- collecting a streaming response
        received.text += chunk;
        const frames = (received.pending + chunk).split("\n\n");
        // eslint-disable-next-line functional/immutable-data -- retain an incomplete frame for the next chunk
        received.pending = frames.pop() ?? "";
        frames.filter((frame) => frame.startsWith("data: ")).forEach((frame) => {
          const event = z.object({ kind: z.string(), secret: z.boolean().optional() }).parse(JSON.parse(frame.slice(6)));
          if (event.kind === "ask") void question(event.secret === true).catch(reject);
        });
      });
      response.on("end", () => { resolve(received.text); });
      response.on("error", reject);
    });
    sent.on("error", reject);
    sent.end();
  });

test("API secret questions can be answered or cancelled; neither answers nor passwords enter the run record", { timeout: 10_000 }, async () => {
  const temporary = mkdtempSync(join(tmpdir(), "kayra-api-secret-"));
  const path = process.env["PATH"];
  const engine = join(temporary, "engine");
  const bin = join(temporary, "bin");
  mkdirSync(join(engine, "scripts", "local"), { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(engine, "scripts", "local", "require-main.sh"), "exit 0\n");
  writeFileSync(join(bin, "ansible-galaxy"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(join(bin, "ansible-playbook"), '#!/bin/sh\n[ "$("$ANSIBLE_VAULT_PASSWORD_FILE")" = test-api-password ] || exit 7\necho "vault opened"\n', { mode: 0o700 });
  const askServer = server("ask", "kind: edge\ntarget: hetzner\ndomain: ask.example\nvault: true");
  const fleet = { root: fleetRoot(must(absolutePath(temporary))), servers: [askServer] };
  const ui = await serve({ kayra: kayraRoot(must(absolutePath(engine))), fleet, version: "test", short: (text) => text, network: quiet }, undefined, 0);
  try {
    // eslint-disable-next-line functional/immutable-data -- fake programs run in this test's temp directory only
    process.env["PATH"] = `${bin}:${path ?? ""}`;
    const token = new URL(ui.url).searchParams.get("token") ?? "";
    const login = await call(ui.port, `/login?token=${token}`);
    const cookie = String(login.headers["set-cookie"]).split(";")[0] ?? "";
    const origin = `http://127.0.0.1:${String(ui.port)}`;
    const start = async (): Promise<string> => {
      const started = await call(ui.port, "/api/runs", { method: "POST", cookie, origin, body: { command: { name: "setup", server: "ask" }, confirm: "ask" } });
      strictEqual(started.status, 201, started.body);
      return z.object({ id: z.string() }).parse(JSON.parse(started.body)).id;
    };
    const first = await start();
    const answered = await followRun(ui.port, first, cookie, async (secret) => {
      strictEqual(secret, true);
      strictEqual((await call(ui.port, `/api/runs/${first}/answer`, { method: "POST", cookie, origin, body: { text: "test-api-password" } })).status, 204);
    });
    strictEqual(answered.includes("vault opened"), true);
    strictEqual(answered.includes('"kind":"ended","failures":0'), true);
    strictEqual(answered.includes("test-api-password"), false);
    const second = await start();
    const cancelled = await followRun(ui.port, second, cookie, async () => {
      strictEqual((await call(ui.port, `/api/runs/${second}/cancel`, { method: "POST", cookie, origin })).status, 202);
    });
    strictEqual(cancelled.includes('"why":"interrupted"'), true);
    strictEqual((await call(ui.port, `/api/runs/${second}/answer`, { method: "POST", cookie, origin, body: { text: "late-secret" } })).status, 404);
    const records = join(temporary, ".cache", "ui", "runs");
    const recorded = readdirSync(records).map((file) => readFileSync(join(records, file), "utf8")).join("\n");
    strictEqual(recorded.includes("test-api-password"), false);
    strictEqual(recorded.includes("late-secret"), false);
  } finally {
    // eslint-disable-next-line functional/immutable-data -- restore the operator's path
    if (path === undefined) delete process.env["PATH"]; else process.env["PATH"] = path;
    await ui.close();
    rmSync(temporary, { recursive: true, force: true });
  }
});
