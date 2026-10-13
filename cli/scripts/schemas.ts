// Writes the JSON Schemas (schema/) and the docs site's settings page from
// cli/src/settings.ts: `npm run schemas`. The test schemas.test.ts fails
// while what is committed differs from what this writes.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jsonSchemas, settingsPage } from "../src/schemas.ts";

const root = join(import.meta.dirname, "..", "..");
mkdirSync(join(root, "schema"), { recursive: true });
for (const [file, schema] of Object.entries(jsonSchemas())) {
  writeFileSync(join(root, "schema", file), `${JSON.stringify(schema, null, 2)}\n`);
}
writeFileSync(join(root, "site", "src", "content", "docs", "reference", "settings.mdx"), settingsPage());
