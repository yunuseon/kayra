import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMap, isSeq, parseDocument } from "yaml";
import { z } from "zod";
import { inspectValues } from "./core/app-values/store.ts";
import { absolutePath, fleetRoot, serverNameSchema, type AbsolutePath, type FleetRoot } from "./core/fleet/brand.ts";
import { loadFleet } from "./core/fleet/load.ts";
import type { Server } from "./core/fleet/model.ts";
import { appEntrySchema } from "./core/fleet/settings.ts";
import { err, flatMap, ok, type Result } from "./lib/result.ts";

const input = z.strictObject({ root: z.string(), server: serverNameSchema, entry: z.record(z.string(), z.unknown()), dir: z.string().optional() });

const load = (root: string, name: string): Result<{ readonly root: FleetRoot; readonly server: Server }, string> => {
  const fleet = flatMap(absolutePath(root), (path) => loadFleet(fleetRoot(path)));
  if (!fleet.ok) return err(`the fleet could not be loaded: ${fleet.error}`);
  const server = fleet.value.servers.find((each) => each.name === name);
  return server === undefined ? err(`no server ${name} in the fleet`) : ok({ root: fleet.value.root, server });
};

/** The entry appended to server.yml's apps, its comments and order kept. */
const register = (server: Server, entry: Readonly<Record<string, unknown>>): Result<string, string> => {
  const file = join(server.dir, "server.yml");
  const document = parseDocument(readFileSync(file, "utf8"));
  const apps = document.get("apps");
  if (apps !== undefined && apps !== null && !isSeq(apps)) return err(`${file}: apps is not a list`);
  if (isSeq(apps)) apps.add(document.createNode(entry));
  else document.set("apps", document.createNode([entry]));
  if (!isMap(document.contents)) return err(`${file} is not a mapping`);
  writeFileSync(file, document.toString());
  return ok(file);
};

const command = (server: Server, app: string, kind: "config" | "secret", key: string) =>
  kind === "config"
    ? `kayra app config set ${server.name} ${app} ${key} VALUE`
    : `kayra app secret generate ${server.name} ${app} ${key}   (or: app secret import ${server.name} ${app} ${key} FILE)`;

const run = async (): Promise<Result<readonly string[], string>> => {
  const request = input.safeParse(JSON.parse(process.argv[2] ?? "null"));
  if (!request.success) return err("invalid app launch request");
  const entry = appEntrySchema.safeParse(request.data.entry);
  if (!entry.success) return err("invalid app entry");
  const app = entry.data.name;
  const dir = request.data.dir === undefined ? ok<AbsolutePath | undefined>(undefined) : absolutePath(request.data.dir);
  if (!dir.ok) return dir;
  const before = load(request.data.root, request.data.server);
  if (!before.ok) return before;
  const lines = before.value.server.apps.some((each) => each.name === app)
    ? [`✓ ${app} is registered in ${before.value.server.name}'s server.yml`]
    : ((): readonly string[] => {
        const written = register(before.value.server, request.data.entry);
        if (!written.ok) return [`✗ ${written.error}`];
        return [
          `✓ registered ${app} in ${written.value}`,
          ...(before.value.server.target === "multipass"
            ? []
            : [`  ${before.value.server.name} is a ${before.value.server.target} server: commit this change and merge it to main, then run the launch again`]),
        ];
      })();
  if (lines[0]?.startsWith("✗") === true) return err(lines[0].slice(2));
  const after = load(request.data.root, request.data.server);
  if (!after.ok) return after;
  const values = await inspectValues(after.value.root, after.value.server, app, dir.value);
  if (!values.ok) return err(`${lines.join("\n")}\n${values.error}`);
  const missing = [
    ...values.value.config.filter((each) => each.state === "missing").map((each) => command(after.value.server, app, "config", each.key)),
    ...values.value.secrets.filter((each) => each.state === "missing").map((each) => command(after.value.server, app, "secret", each.key)),
  ];
  if (values.value.hint !== null) return err(`${lines.join("\n")}\n${values.value.hint}`);
  if (missing.length > 0) return err(`${lines.join("\n")}\n${app} needs ${String(missing.length)} value(s) before it can run; set them, then run the launch again:\n${missing.map((line) => `  ${line}`).join("\n")}`);
  return ok([...lines, `✓ every value ${app} declares is set (${String(values.value.config.length)} config, ${String(values.value.secrets.length)} secret)`]);
};

const result = await run().catch(() => err("the launch could not prepare the app; check file access and vault configuration"));
if (result.ok) process.stdout.write(`${result.value.join("\n")}\n`);
else {
  process.stderr.write(`${result.error}\n`);
  // eslint-disable-next-line functional/immutable-data -- exit after flushing diagnostics
  process.exitCode = 1;
}
