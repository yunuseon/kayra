#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = new URL("../cli/src/app-values.ts", import.meta.url);
await import(existsSync(fileURLToPath(source)) ? source.href : new URL("../cli/dist/app-values.js", import.meta.url).href);
