import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { z } from "zod";
import { absolutePath, fleetRoot, kayraRoot } from "../src/core/brand.ts";
import type { Network } from "../src/core/commands/status.ts";
import { admit, cookieName } from "../src/clients/api/auth.ts";
import { changes, commandInput, offered, toPlanned, words } from "../src/clients/api/commands.ts";
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

test("commands: checked against the fleet, said as typed, offered by kind", () => {
  const fleet = { root, servers: [prod, lab] };
  deepStrictEqual(must(toPlanned(fleet, { name: "deploy", server: "prod" })), { name: "deploy", server: "prod" });
  deepStrictEqual(must(toPlanned(fleet, { name: "app rollback", server: "prod", app: "shop", sha: "0123abc" })), {
    name: "app rollback",
    server: "prod",
    app: "shop",
    more: "0123abc",
  });
  strictEqual(toPlanned(fleet, { name: "deploy", server: "nope" }).ok, false);
  strictEqual(toPlanned(fleet, { name: "app purge", server: "prod", app: "other" }).ok, false);
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
