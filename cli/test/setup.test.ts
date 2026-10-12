import { strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { absolutePath, kayraRoot, kayraVersion } from "../src/brand.ts";
import { setup } from "../src/commands/server.ts";
import { render } from "../src/plan.ts";
import { must, root, server } from "./support.ts";

const engine = { kayra: kayraRoot(must(absolutePath("/kayra"))), version: must(kayraVersion("1.2.3")), fleet: root };
const home = "target: home\ndomain: forge.test\nvault: true";
const mkcert = (vars: string): boolean =>
  render(must(setup(engine, server("forge", home, { vars })))).some((line) => line.includes("certs.sh"));

test("setup makes mkcert certs for a home platform server, unless its certificates come by DNS-01", () => {
  strictEqual(mkcert(""), true);
  strictEqual(mkcert("acme_dns: hetzner\n"), false);
});
