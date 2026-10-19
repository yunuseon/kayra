import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { openapi } from "../src/clients/api/openapi.ts";
import { contractTypes } from "../src/clients/wire/contract.ts";
import { apiReference } from "./api-reference.ts";

const root = join(import.meta.dirname, "../..");
const version = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).version;
writeFileSync(join(root, "cli/src/clients/wire/contract.gen.ts"), contractTypes());
writeFileSync(join(root, "cli/src/clients/api/openapi.json"), `${JSON.stringify(openapi(version), null, 2)}\n`);
writeFileSync(join(root, "site/src/content/docs/reference/api.md"), apiReference(openapi(version)));
