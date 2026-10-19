import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { absolutePath, kayraRoot } from "../src/core/fleet/brand.ts";
import { appCheck } from "../src/core/recipes/app-check.ts";
import { render } from "../src/core/plan/describe.ts";
import { must } from "./support.ts";

const kayra = kayraRoot(must(absolutePath("/kayra")));
const root = must(absolutePath("/repo"));
const manifest = "name: shop\ncompose: [deploy/compose.yml]\nsubdomains: [www]\n";

test("app check: the tools, then app-check.sh on the app's root", () => {
  const plan = must(appCheck(kayra, root, manifest));
  deepStrictEqual(render(plan).at(-1), "run      bash /kayra/scripts/local/app-check.sh /repo");
  strictEqual(plan.filter((step) => step.kind === "check").length, 4);
});

test("app check: no app.yml, a broken one, or an invalid name stops before any script", () => {
  deepStrictEqual(appCheck(kayra, root, undefined), { ok: false, error: "no app.yml in /repo" });
  strictEqual(appCheck(kayra, root, "name: [").ok, false);
  deepStrictEqual(appCheck(kayra, root, `${manifest}extra: 1\n`).ok, false);
  deepStrictEqual(appCheck(kayra, root, manifest.replace("shop", "Shop")).ok, false);
});
