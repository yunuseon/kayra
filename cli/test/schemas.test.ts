import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { jsonSchemas, settingsPage } from "../src/core/fleet/docs.ts";
import { settings } from "../src/core/fleet/settings.ts";

const root = join(import.meta.dirname, "..", "..");

test("the committed JSON Schemas are what the settings registry says (npm run schemas)", () => {
  Object.entries(jsonSchemas()).forEach(([file, schema]) => {
    const committed: unknown = JSON.parse(readFileSync(join(root, "schema", file), "utf8"));
    deepStrictEqual(committed, schema, `schema/${file} is stale: npm run schemas`);
  });
});

test("the docs' settings page is what the settings registry says (npm run schemas)", () => {
  strictEqual(
    readFileSync(join(root, "site", "src", "content", "docs", "reference", "settings.mdx"), "utf8"),
    settingsPage(),
  );
});

test("no secret's schema checks its value's form: validate sees an encrypted secrets.yml's values only as stand-ins", () => {
  const formed = settings
    .filter((setting) => setting.secret)
    .filter((setting) => JSON.stringify(z.toJSONSchema(setting.schema, { io: "input" })).includes('"pattern"'))
    .map((setting) => setting.name);
  deepStrictEqual(formed, []);
});
