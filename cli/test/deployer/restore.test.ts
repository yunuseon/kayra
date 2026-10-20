import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { toRestore } from "../../src/deployer/runs/restore.ts";
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
