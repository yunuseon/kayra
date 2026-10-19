import { deepStrictEqual, rejects, strictEqual } from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { absolutePath, fleetRoot, kayraRoot, kayraVersion } from "../src/core/fleet/brand.ts";
import { operation, operationNames } from "../src/core/operations/catalog.ts";
import { contextFor } from "../src/core/operations/dispatch.ts";
import { reaches } from "../src/clients/mcp/tools.ts";
import { mcpServer, type Busy } from "../src/clients/mcp/server.ts";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { schemas } from "../src/clients/wire/schemas.ts";
import { ok } from "../src/lib/result.ts";
import { must, server } from "./support.ts";

type Elicited = { readonly message: string; readonly answer: "accept" | "decline"; readonly typed?: string };

/** A fleet of two servers (lab on multipass, prod on hetzner, vaulted with no password file), every tool a stub. */
const fixture = async (elicit: (message: string) => Elicited = (message) => ({ message, answer: "decline" }), era: "2025" | "2026" = "2025") => {
  const dir = mkdtempSync(join(tmpdir(), "kayra-mcp-"));
  const engine = join(dir, "engine");
  const bin = join(dir, "bin");
  const path = process.env["PATH"];
  mkdirSync(join(engine, "scripts/local"), { recursive: true });
  mkdirSync(bin);
  ["require-main.sh", "require-latest-state.sh", "home-reach.sh", "certs.sh", "app-check.sh", "verify.sh", "app-manifests.sh"].forEach((name) => { writeFileSync(join(engine, "scripts/local", name), "exit 0\n"); });
  const program = (name: string, text: string): void => { writeFileSync(join(bin, name), `#!/bin/sh\n${text}\n`, { mode: 0o700 }); };
  program("ansible-galaxy", "exit 0");
  program("ansible-playbook", `[ ! -f "${join(dir, "fail")}" ] || { echo "TASK [broken] fatal: it broke"; exit 3; }\necho "playbook finished"`);
  program("tofu", `case "$*" in *destroy*) echo "destroyed" > "${join(dir, "destroyed")}";; *output*) echo 192.0.2.1;; *state*) echo hcloud_server.this;; esac`);
  program("ssh", `case "$*" in
    *'ctl runs'*) echo '{"app":"shop","runs":[]}' ;;
    *wait*) exec sleep 30 ;;
    *) echo "ran: $*" ;;
  esac`);
  const lab = server("lab", "target: multipass\ndomain: lab.test\nvault: false\napps: [{name: shop, repo: https://git.example/shop.git}]", { secrets: "a: b\n" });
  const prod = server("prod", "kind: edge\ntarget: hetzner\ndomain: prod.example\nvault: true");
  const fleet = { root: fleetRoot(must(absolutePath(dir))), servers: [lab, prod] };
  const context = contextFor({
    kayra: kayraRoot(must(absolutePath(engine))), fleet, version: must(kayraVersion("0.0.0-test")), here: must(absolutePath(dir)),
    network: { connect: () => Promise.resolve({ kind: "skipped" as const }), get: () => Promise.resolve({ kind: "skipped" as const }) },
    tofu: { state: () => Promise.resolve(ok([])), output: () => Promise.resolve(undefined) },
  });
  // eslint-disable-next-line functional/immutable-data -- all subprocesses use fixture programs, never real infrastructure tools
  process.env["PATH"] = `${bin}:${path ?? ""}`;
  const running = new Set<string>();
  const busy: Busy = {
    has: (name) => running.has(name),
    // eslint-disable-next-line functional/immutable-data -- the fixture's busy servers
    add: (name) => { running.add(name); },
    // eslint-disable-next-line functional/immutable-data -- see above
    delete: (name) => { running.delete(name); },
  };
  // eslint-disable-next-line functional/prefer-immutable-types -- what the operator was asked, in order
  const asked: Elicited[] = [];
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: "test", version: "0" },
    { capabilities: { elicitation: { form: {} } }, ...(era === "2026" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {}) },
  );
  client.setRequestHandler("elicitation/create", (request) => {
    const given = elicit(request.params.message);
    // eslint-disable-next-line functional/immutable-data -- see above
    asked.push(given);
    return given.answer === "accept" ? { action: "accept", content: { typed: given.typed ?? "" } } : { action: "decline" };
  });
  const served = era === "2026" ? serveStdio(() => mcpServer({ context, short: (text) => text }, busy), { transport: serverSide }) : undefined;
  if (served === undefined) await mcpServer({ context, short: (text) => text }, busy).connect(serverSide);
  await client.connect(clientSide);
  strictEqual(client.getNegotiatedProtocolVersion()?.startsWith(era), true);
  // eslint-disable-next-line functional/prefer-immutable-types -- the SDK's result type
  const text = (result: Awaited<ReturnType<typeof client.callTool>>) =>
    result.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
  return {
    dir, client, asked, text,
    cleanup: async () => {
      await client.close();
      await served?.close();
      // eslint-disable-next-line functional/immutable-data -- restore the operator's environment
      if (path === undefined) delete process.env["PATH"]; else process.env["PATH"] = path;
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

test("tools/list offers every operation but the interactive shell, servers as choices, destroying ones approved every time", async (t) => {
  const mcp = await fixture(); t.after(mcp.cleanup);
  const { tools } = await mcp.client.listTools();
  strictEqual(tools.length, operationNames.length - 1);
  strictEqual(tools.some((tool) => tool.name === "ssh"), false);
  const deploy = tools.find((tool) => tool.name === "deploy");
  deepStrictEqual(deploy?.inputSchema.properties?.["server"], { type: "string", minLength: 1, description: "A server of the fleet (servers/<name>/)", enum: ["lab", "prod"] });
  strictEqual(typeof deploy.inputSchema.properties["dryRun"], "object");
  strictEqual(tools.find((tool) => tool.name === "status")?.inputSchema.properties?.["dryRun"], undefined);
  tools.forEach((tool) => {
    const name = operationNames.find((each) => "tool" in reaches[each] && reaches[each].tool === tool.name);
    if (name === undefined) throw new Error(`${tool.name}: no operation`);
    const { effect } = operation(name);
    const { readOnlyHint, destructiveHint } = tool.annotations ?? {};
    deepStrictEqual([readOnlyHint, destructiveHint], [effect === "reads", effect === "destroys"], tool.name);
    strictEqual(tool._meta?.["anthropic/requiresUserInteraction"] === true, effect === "destroys", tool.name);
  });
  strictEqual(operationNames.every((name) => !("dryRun" in operation(name).input.def) && !("verbose" in operation(name).input.def)), true);
});

test("dryRun lists the plan and runs nothing; a run passes and says each step as it begins", async (t) => {
  const mcp = await fixture(); t.after(mcp.cleanup);
  const listed = await mcp.client.callTool({ name: "setup", arguments: { server: "lab", dryRun: true } });
  strictEqual(listed.isError, undefined);
  strictEqual(mcp.text(listed).includes("ansible-playbook"), true);
  // eslint-disable-next-line functional/prefer-immutable-types -- the progress the call reported
  const progress: string[] = [];
  // eslint-disable-next-line functional/immutable-data -- see above
  const ran = await mcp.client.callTool({ name: "setup", arguments: { server: "lab" } }, { onprogress: (each) => { progress.push(each.message ?? ""); } });
  strictEqual(ran.isError, undefined, mcp.text(ran));
  strictEqual(mcp.text(ran).includes("playbook finished"), true);
  strictEqual(progress.length > 0 && progress.every((message) => message.length > 0), true);
});

test("a failing step is a tool error carrying its output", async (t) => {
  const mcp = await fixture(); t.after(mcp.cleanup);
  writeFileSync(join(mcp.dir, "fail"), "");
  const ran = await mcp.client.callTool({ name: "setup", arguments: { server: "lab" } });
  strictEqual(ran.isError, true);
  strictEqual(mcp.text(ran).includes("TASK [broken] fatal: it broke"), true);
  strictEqual(mcp.text(ran).includes("✗"), true);
});

(["2025", "2026"] as const).forEach((era) => {
  test(`destroying asks the operator to type the server's name first; declined, nothing is destroyed (${era})`, async (t) => {
    const declined = await fixture((message) => ({ message, answer: "decline" }), era); t.after(declined.cleanup);
    const stopped = await declined.client.callTool({ name: "down", arguments: { server: "prod" } });
    strictEqual(declined.asked.length, 1);
    strictEqual(declined.asked[0]?.message.includes("Type prod to confirm."), true);
    strictEqual(stopped.isError, true);
    strictEqual(declined.text(stopped).includes("not confirmed"), true);
    strictEqual(existsSync(join(declined.dir, "destroyed")), false);
    const typed = await fixture((message) => ({ message, answer: "accept", typed: "prod" }), era); t.after(typed.cleanup);
    const ran = await typed.client.callTool({ name: "down", arguments: { server: "prod" } });
    strictEqual(ran.isError, undefined, typed.text(ran));
    strictEqual(readFileSync(join(typed.dir, "destroyed"), "utf8").trim(), "destroyed");
  });
});

test("no password passes through MCP: a vaulted server without a password file stops, and says how to give one", async (t) => {
  const mcp = await fixture(); t.after(mcp.cleanup);
  const ran = await mcp.client.callTool({ name: "setup", arguments: { server: "prod" } });
  strictEqual(ran.isError, true);
  strictEqual(mcp.text(ran).includes("vault_password_file in servers/prod/server.yml"), true);
  strictEqual(mcp.asked.length, 0);
});

test("input is checked by the core; queries and status answer in the wire's shapes", async (t) => {
  const mcp = await fixture(); t.after(mcp.cleanup);
  strictEqual((await mcp.client.callTool({ name: "deploy", arguments: { server: "nowhere" } })).isError, true);
  strictEqual((await mcp.client.callTool({ name: "ssh", arguments: { server: "lab" } })).isError, true);
  const status = await mcp.client.callTool({ name: "status", arguments: { offline: true } });
  strictEqual(schemas.Status.safeParse(status.structuredContent).success, true);
  const runs = await mcp.client.callTool({ name: "app_runs", arguments: { server: "lab", app: "shop" } });
  strictEqual(schemas.AppRuns.safeParse(runs.structuredContent).success, true, mcp.text(runs));
  strictEqual(mcp.text(await mcp.client.callTool({ name: "version", arguments: {} })), "0.0.0-test");
});

test("cancelling a call stops its step; a second change on a busy server waits its turn", { timeout: 10_000 }, async (t) => {
  const mcp = await fixture(); t.after(mcp.cleanup);
  const stop = new AbortController();
  const waiting = mcp.client.callTool({ name: "ssh_exec", arguments: { server: "lab", command: ["wait"] } }, { signal: stop.signal });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const second = await mcp.client.callTool({ name: "ssh_exec", arguments: { server: "lab", command: ["uptime"] } });
  strictEqual(second.isError, true);
  strictEqual(mcp.text(second).includes("still running"), true);
  stop.abort();
  await rejects(waiting);
  const started = Date.now();
  const free = async (): Promise<string> => {
    const again = mcp.text(await mcp.client.callTool({ name: "ssh_exec", arguments: { server: "lab", command: ["uptime"] } }));
    return again.includes("still running") && Date.now() - started < 8_000 ? new Promise((resolve) => setTimeout(() => { resolve(free()); }, 100)) : again;
  };
  strictEqual((await free()).includes("ran:"), true);
});

test("kayra mcp speaks only the protocol on stdout, in the newest revision as in the older ones", { timeout: 20_000 }, async (t) => {
  const fleetDir = join(import.meta.dirname, "golden", "fleet");
  const main = join(import.meta.dirname, "..", "src", "main.ts");
  await Promise.all((["auto", "legacy"] as const).map(async (mode) => {
    const client = new Client({ name: "test", version: "0" }, { versionNegotiation: { mode } });
    t.after(() => client.close());
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [main, "mcp"], cwd: fleetDir, stderr: "ignore" }));
    strictEqual(client.getNegotiatedProtocolVersion()?.startsWith(mode === "auto" ? "2026" : "2025"), true, mode);
    const { tools } = await client.listTools();
    strictEqual(tools.length, operationNames.length - 1, mode);
    const listed = await client.callTool({ name: "setup", arguments: { server: "shop-test", dryRun: true } });
    strictEqual(listed.isError, undefined, mode);
    strictEqual(JSON.stringify(listed.content).includes("ansible-playbook"), true, mode);
  }));
});

test("the guard lets through exactly the tools that change nothing", () => {
  const guard = readFileSync(join(import.meta.dirname, "..", "..", "scripts", "agent", "guard.sh"), "utf8");
  const listed = /^mcp_reads='([^']*)'$/m.exec(guard)?.[1]?.split("|") ?? [];
  const reads = operationNames.flatMap((name) => {
    const offer = reaches[name];
    return "tool" in offer && operation(name).effect === "reads" ? [offer.tool] : [];
  });
  deepStrictEqual(listed.toSorted(), reads.toSorted());
});
