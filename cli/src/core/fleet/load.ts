import { existsSync } from "node:fs";
import { join } from "node:path";
import { filesIn, foldersIn, textAt } from "../adapters/fs.ts";
import { fleetRoot, serverDir, serverName, within, type AbsolutePath, type FleetRoot } from "./brand.ts";
import { fields, parseServer } from "./parse.ts";
import type { Fleet, Server } from "./model.ts";
import { all, attempt, err, flatMap, map, ok, type Result } from "../../result.ts";
import { defaultsSchema } from "./settings.ts";
import { checkSettings, knownSettings } from "./shape.ts";

/** The fleet is the nearest directory, from `from` upwards, with a servers/defaults.yml. */
export const findFleetRoot = (from: AbsolutePath): Result<FleetRoot, string> => {
  if (existsSync(join(from, "servers", "defaults.yml"))) return ok(fleetRoot(from));
  const parent = within(from, "..");
  return parent === from
    ? err("no fleet here: no servers/defaults.yml in this directory or above it")
    : findFleetRoot(parent);
};

/** Every file of a server, read once: what every command, and validate, works from. */
const readServer = (root: FleetRoot, entry: string): Result<Server, string> => {
  const name = serverName(entry);
  if (!name.ok) return err(`servers/${entry}: ${name.error}`);
  const dir = serverDir(root, name.value);
  const server = parseServer({
    name: name.value,
    dir,
    descriptor: textAt(join(dir, "server.yml")) ?? "",
    vars: textAt(join(dir, "vars.yml")),
    secrets: textAt(join(dir, "secrets.yml")),
    inventory: textAt(join(dir, "inventory.ini")),
    hasTerraform: existsSync(join(dir, "terraform")),
    stacks: foldersIn(join(dir, "stacks")).map((stack) => ({ name: stack, compose: textAt(join(dir, "stacks", stack, "compose.yaml")) })),
    appValues: filesIn(join(dir, "apps"), ".yml").map((file) => ({ file, text: textAt(join(dir, "apps", file)) ?? "" })),
  });
  return server.ok ? server : err(`servers/${entry}/server.yml: ${server.error}`);
};

/** servers/defaults.yml: settings shared by every server, any kind's. */
const checkDefaults = (root: FleetRoot): Result<true, string> => {
  const values = fields(textAt(join(root, "servers", "defaults.yml")) ?? "");
  if (!values.ok) return err(`servers/defaults.yml ${values.error}`);
  return map(checkSettings("servers/defaults.yml", values.value, defaultsSchema, knownSettings(undefined)), () => true);
};

const fleetOf = (root: FleetRoot): Result<Fleet, string> =>
  map(
    all(
      foldersIn(join(root, "servers"))
        .filter((entry) => existsSync(join(root, "servers", entry, "server.yml")))
        .map((entry) => readServer(root, entry)),
    ),
    (servers) => ({ root, servers }),
  );

export const loadFleet = (root: FleetRoot): Result<Fleet, string> =>
  attempt(() => flatMap(checkDefaults(root), () => fleetOf(root)), (why) => `the fleet could not be read: ${why}`);
