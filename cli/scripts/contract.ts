import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { contractTypes, openapi } from "../src/clients/api/contract.ts";

const root = join(import.meta.dirname, "../..");
const version = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).version;
writeFileSync(join(root, "cli/src/clients/api/contract.gen.ts"), contractTypes());
writeFileSync(join(root, "cli/src/clients/api/openapi.json"), `${JSON.stringify(openapi(version), null, 2)}\n`);
