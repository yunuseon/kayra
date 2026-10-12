#!/usr/bin/env node
// The installed package runs the compiled CLI (Node strips no types inside
// node_modules); a checkout of kayra runs its TypeScript directly.
import { existsSync } from "node:fs";

const compiled = new URL("../cli/dist/main.js", import.meta.url);
await import(existsSync(compiled) ? compiled.href : new URL("../cli/src/main.ts", import.meta.url).href);
