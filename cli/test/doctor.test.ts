import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { absolutePath, kayraRoot, kayraVersion } from "../src/core/fleet/brand.ts";
import { doctor } from "../src/core/recipes/doctor.ts";
import { render } from "../src/core/plan/describe.ts";
import { fleet, must, root, server } from "./support.ts";

const engine = { kayra: kayraRoot(must(absolutePath("/kayra"))), fleet: root, version: must(kayraVersion("0.19.0")) };
const shop = "apps: [{name: shop, repo: https://git.example/shop.git}]";

test("doctor checks the tools the fleet needs, every age key, every app repository and every home server", () => {
  const plan = doctor(
    fleet(
      server("box", "kind: nas\ntarget: home\ndomain: home.test\nage_key_file: /keys.txt", {
        hasTerraform: false,
        secrets: "a: ENC[AES256_GCM,data:AA==,iv:AA==,tag:AA==,type:str]\nsops:\n    age:\n        - recipient: age1se1qexample\n",
      }),
      server("shop-prod", `target: hetzner\ndomain: shop.example\n${shop}`),
      server("shop-test", `target: multipass\ndomain: shop.test\n${shop}`, { secrets: "git_token: test\n" }),
    ),
    engine,
  );
  deepStrictEqual(render(plan), [
    "check    git (every server): command -v git",
    "check    ssh (every server): command -v ssh",
    "check    yq (every server): command -v yq",
    "check    jq (every server): command -v jq",
    "check    ansible-playbook (every server): command -v ansible-playbook",
    "check    ansible-galaxy (every server): command -v ansible-galaxy",
    "check    sops (box, shop-prod): command -v sops",
    "check    age-plugin-se (box): command -v age-plugin-se",
    "check    tofu (shop-prod, shop-test): command -v tofu",
    "check    mkcert (shop-test): command -v mkcert",
    "check    multipass (shop-test): command -v multipass",
    "check    box's age_key_file is here: test -f /keys.txt",
    "check    git can read https://git.example/shop.git: sh -c 'GIT_TERMINAL_PROMPT=0 git ls-remote \"$1\" HEAD' sh https://git.example/shop.git",
    "check    box answers over SSH: FLEET_ROOT=/fleet bash /kayra/scripts/local/home-reach.sh box nas",
  ]);
});

test("doctor reports every failure: none of its checks stops the plan", () => {
  deepStrictEqual(
    doctor(fleet(server("a", "target: home\ndomain: a.test")), engine).filter(
      (step) => step.kind !== "check" || step.onFailure !== "continue",
    ),
    [],
  );
});
