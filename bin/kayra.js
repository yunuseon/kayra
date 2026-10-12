#!/usr/bin/env node
// Runs the kayra the fleet pins. Whichever `kayra` is on PATH (a global
// install, a linked checkout) hands over to node_modules/@yunuseon/kayra of the
// fleet it is run in (the nearest directory with servers/defaults.yml), as
// turbo or nx do; without one, it runs itself. `npm link @yunuseon/kayra` in a
// fleet makes that pinned copy a checkout, for working on kayra itself.
//
// The installed package runs the compiled CLI (Node strips no types inside
// node_modules); a checkout runs its TypeScript directly.
import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const self = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));

const fleetOf = (dir) =>
  existsSync(join(dir, "servers", "defaults.yml")) ? dir : dirname(dir) === dir ? undefined : fleetOf(dirname(dir));

const fleet = fleetOf(process.cwd());
const pinnedDir = fleet === undefined ? undefined : join(fleet, "node_modules", "@yunuseon", "kayra");
const pinned = pinnedDir !== undefined && existsSync(pinnedDir) ? realpathSync(pinnedDir) : self;

if (pinned !== self) {
  await import(pathToFileURL(join(pinned, "bin", "kayra.js")).href);
} else {
  const compiled = join(self, "cli", "dist", "main.js");
  await import(pathToFileURL(existsSync(compiled) ? compiled : join(self, "cli", "src", "main.ts")).href);
}
