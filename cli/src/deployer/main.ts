#!/usr/bin/env node
import { serveBuilder } from "./build/builder.ts";
import { ctl } from "./ctl/ctl.ts";
import { serveDeployer } from "./deployer.ts";

/** One program, three roles: `builder`, `deployer` (the two daemons) and `ctl` (the operator, inside the deployer). */
const [role, ...args] = process.argv.slice(2);
if (role === "builder") serveBuilder(process.env);
else if (role === "deployer") serveDeployer(process.env);
else if (role === "ctl") {
  // eslint-disable-next-line functional/immutable-data -- the exit status; process.exit() could cut piped output short
  process.exitCode = await ctl(args);
} else {
  console.error("usage: main.ts builder | deployer | ctl …");
  // eslint-disable-next-line functional/immutable-data -- the exit status
  process.exitCode = 2;
}
