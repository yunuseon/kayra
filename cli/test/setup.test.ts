import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { absolutePath, kayraRoot, kayraVersion } from "../src/core/fleet/brand.ts";
import { deploy, preview, setup } from "../src/core/recipes/host.ts";
import { verbose } from "../src/core/recipes/steps.ts";
import { render } from "../src/core/plan/describe.ts";
import { must, root, server } from "./support.ts";

const engine = { kayra: kayraRoot(must(absolutePath("/kayra"))), fleet: root, version: must(kayraVersion("0.19.0")) };
const home = "target: home\ndomain: forge.test";
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

test("every host playbook records the kayra that runs it, and verify knows which that is", () => {
  const forge = server("forge", home, { vars: "acme_dns: hetzner\n" });
  const playbooks = [must(setup(engine, forge)), must(preview(engine, forge))].map((plan) =>
    plan.flatMap((step) => (step.kind === "run" && step.argv[0] === "ansible-playbook" ? [step.argv.includes("kayra_version=0.19.0")] : [])),
  );
  deepStrictEqual(playbooks, [[true], [true]]);
  const verify = must(deploy(engine, forge)).at(-1);
  deepStrictEqual(verify?.kind === "run" ? verify.env["KAYRA_VERSION"] : undefined, "0.19.0");
});
