#!/usr/bin/env node
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = new URL("../cli/src/app-init.ts", import.meta.url);
await import(existsSync(fileURLToPath(source)) ? source.href : new URL("../cli/dist/app-init.js", import.meta.url).href);
