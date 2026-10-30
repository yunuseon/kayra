import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { toRestore } from "../../src/deployer/runs/restore.ts";
import { toRestore as ownedDecision } from "../../src/server/deployment/legacy-restore.ts";
import { commit, name } from "./support.ts";

test("restore: an app deployed once and running nothing now is deployed again at its live release; the rest are left alone", () => {
  const shop = name("shop");
  const blog = name("blog");
  const fresh = name("fresh");
  deepStrictEqual(
    toRestore(
      [{ app: shop, live: commit("a") }, { app: blog, live: commit("b") }, { app: fresh, live: undefined }],
      (app) => app === blog,
    ),
    [{ app: shop, live: commit("a") }],
  );
});

test("legacy restore re-export shares the deployment-owned decision and skips never-deployed apps", () => {
  strictEqual(toRestore, ownedDecision);
  const first = name("first");
  const fresh = name("fresh");
  const second = name("second");
  deepStrictEqual(toRestore(
    [{ app: first, live: commit("a") }, { app: fresh, live: undefined }, { app: second, live: commit("b") }],
    (app) => { strictEqual(app === fresh, false); return false; },
  ), [{ app: first, live: commit("a") }, { app: second, live: commit("b") }]);
});
