import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { absolutePath, kayraRoot } from "../src/core/brand.ts";
import { doctor } from "../src/core/commands/doctor.ts";
import { render } from "../src/core/plan.ts";
import { fleet, must, server } from "./support.ts";

const kayra = kayraRoot(must(absolutePath("/kayra")));
const shop = "apps: [{name: shop, repo: https://git.example/shop.git}]";

test("doctor checks the tools the fleet needs, every vault, every app repository and every home server", () => {
  const plan = doctor(
    fleet(
      server("box", "kind: nas\ntarget: home\ndomain: home.test\nvault: true\nvault_password_file: /pass", {
        terraform: false,
      }),
      server("shop-prod", `target: hetzner\ndomain: shop.example\nvault: true\n${shop}`),
      // Its one secret vaulted inline: ansible-vault cannot open the file, setup does.
      server("shop-test", `target: multipass\ndomain: shop.test\nvault: true\nvault_password_file: /pass\n${shop}`, {
        secrets: "git_token: !vault |\n  $ANSIBLE_VAULT;1.1;AES256\n",
      }),
    ),
    kayra,
  );
  deepStrictEqual(render(plan), [
    "check    git (every server): command -v git",
    "check    ssh (every server): command -v ssh",
    "check    yq (every server): command -v yq",
    "check    jq (every server): command -v jq",
    "check    ansible-playbook (every server): command -v ansible-playbook",
    "check    ansible-galaxy (every server): command -v ansible-galaxy",
    "check    ansible-vault (every server): command -v ansible-vault",
    "check    tofu (shop-prod, shop-test): command -v tofu",
    "check    mkcert (shop-test): command -v mkcert",
    "check    multipass (shop-test): command -v multipass",
    "check    vault password opens box's secrets.yml: ansible-vault view --vault-password-file /pass /fleet/servers/box/secrets.yml",
    "check    git can read https://git.example/shop.git: sh -c 'GIT_TERMINAL_PROMPT=0 git ls-remote \"$1\" HEAD' sh https://git.example/shop.git",
    "check    box answers over SSH: FLEET_ROOT=/fleet bash /kayra/scripts/local/home-reach.sh box nas",
  ]);
});

test("doctor reports every failure: none of its checks stops the plan", () => {
  deepStrictEqual(
    doctor(fleet(server("a", "target: home\ndomain: a.test\nvault: true")), kayra).filter(
      (step) => step.kind !== "check" || step.onFailure !== "continue",
    ),
    [],
  );
});
