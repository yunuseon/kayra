import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { absolutePath, kayraRoot } from "../src/core/fleet/brand.ts";
import { setup } from "../src/core/recipes/host.ts";
import { verbose } from "../src/core/recipes/steps.ts";
import { render } from "../src/core/plan/describe.ts";
import { must, root, server } from "./support.ts";

const engine = { kayra: kayraRoot(must(absolutePath("/kayra"))), fleet: root };
const home = "target: home\ndomain: forge.test\nvault: true";
const mkcert = (vars: string): boolean =>
  render(must(setup(engine, server("forge", home, { vars })))).some((line) => line.includes("certs.sh"));

test("setup makes mkcert certs for a home platform server, unless its certificates come by DNS-01", () => {
  strictEqual(mkcert(""), true);
  strictEqual(mkcert("acme_dns: hetzner\n"), false);
});

test("--verbose gives every playbook Ansible's own output and -v, and leaves the other steps as they are", () => {
  const plan = must(setup(engine, server("forge", home, { vars: "acme_dns: hetzner\n" })));
  const changed = verbose(plan)
    .map((step, index) => [step, plan[index]] as const)
    .filter(([after, before]) => JSON.stringify(after) !== JSON.stringify(before))
    .map(([after]) => (after.kind === "run" ? [after.argv.slice(0, 2), after.env["ANSIBLE_STDOUT_CALLBACK"]] : after.kind));
  deepStrictEqual(changed, [[["ansible-playbook", "-v"], "default"]]);
});
