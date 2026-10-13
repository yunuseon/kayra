import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fleetRoot, serverDir, serverName, within, type AbsolutePath, type FleetRoot } from "./brand.ts";
import { parseServer, yamlOf, type Fleet, type Server, type ServerFiles } from "./fleet.ts";
import { all, err, flatMap, map, ok, type Result } from "./result.ts";
import { defaultsSchema } from "./settings.ts";
import { checkSettings, knownSettings } from "./validate.ts";

/** The fleet is the nearest directory, from `from` upwards, with a servers/defaults.yml. */
export const findFleetRoot = (from: AbsolutePath): Result<FleetRoot, string> => {
  if (existsSync(join(from, "servers", "defaults.yml"))) return ok(fleetRoot(from));
  const parent = within(from, "..");
  return parent === from
    ? err("no fleet here: no servers/defaults.yml in this directory or above it")
    : findFleetRoot(parent);
};

const text = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

const stacks = (dir: string): readonly string[] =>
  existsSync(join(dir, "stacks"))
    ? readdirSync(join(dir, "stacks"))
        .toSorted()
        .flatMap((stack) => text(join(dir, "stacks", stack, "compose.yaml")) ?? [])
    : [];

const appValues = (dir: string): ServerFiles["appValues"] =>
  existsSync(join(dir, "apps"))
    ? readdirSync(join(dir, "apps"))
        .filter((file) => file.endsWith(".yml"))
        .toSorted()
        .map((file) => ({ file, text: readFileSync(join(dir, "apps", file), "utf8") }))
    : [];

const readServer = (root: FleetRoot, entry: string): Result<Server, string> => {
  const name = serverName(entry);
  if (!name.ok) return err(`servers/${entry}: ${name.error}`);
  const dir = serverDir(root, name.value);
  const server = parseServer({
    name: name.value,
    dir,
    descriptor: readFileSync(join(dir, "server.yml"), "utf8"),
    vars: text(join(dir, "vars.yml")),
    secrets: text(join(dir, "secrets.yml")),
    inventory: text(join(dir, "inventory.ini")),
    terraform: existsSync(join(dir, "terraform")),
    stacks: stacks(dir),
    appValues: appValues(dir),
  });
  return server.ok ? server : err(`servers/${entry}/server.yml: ${server.error}`);
};

/** servers/defaults.yml: settings shared by every server, any kind's. */
const checkDefaults = (root: FleetRoot): Result<true, string> => {
  const parsed = yamlOf(readFileSync(join(root, "servers", "defaults.yml"), "utf8"));
  if (!parsed.ok) return err(`servers/defaults.yml ${parsed.error}`);
  const values = parsed.value;
  if (values === null || values === undefined) return ok(true);
  if (typeof values !== "object" || Array.isArray(values)) return err("servers/defaults.yml is not a YAML mapping");
  return map(checkSettings("servers/defaults.yml", Object.fromEntries(Object.entries(values)), defaultsSchema, knownSettings(undefined)), () => true);
};

export const loadFleet = (root: FleetRoot): Result<Fleet, string> =>
  flatMap(checkDefaults(root), () => fleetOf(root));

const fleetOf = (root: FleetRoot): Result<Fleet, string> =>
  map(
    all(
      readdirSync(join(root, "servers"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(root, "servers", entry.name, "server.yml")))
        .map((entry) => entry.name)
        .toSorted()
        .map((entry) => readServer(root, entry)),
    ),
    (servers) => ({ root, servers }),
  );
