import { resolve } from "node:path";
import { editSchema, requirements } from "../app-values/model.ts";
import type { Edit } from "../app-values/model.ts";
import type { Server } from "../fleet/model.ts";
import { within, type AbsolutePath, type AppName } from "../fleet/brand.ts";
import { run, type Plan } from "../plan/model.ts";
import type { Engine } from "./steps.ts";
import { err, ok } from "../../lib/result.ts";

export const appValues = (engine: Engine, server: Server, app: AppName, edit: Edit, here: AbsolutePath, read: (path: AbsolutePath) => string | undefined, dir?: AbsolutePath) => {
  if (!editSchema.safeParse(edit).success) return err("invalid app value input");
  const required = requirements(engine.fleet, server, app, read, dir);
  if (!required.ok) return required;
  const keys = edit.kind === "config" ? required.value.config : required.value.secrets;
  if (!keys.includes(edit.key)) return err(`${edit.key} is not a declared ${edit.kind === "config" ? "configuration" : "secret"} key`);
  const input = { ...(dir === undefined ? {} : { dir }), root: engine.fleet, server: server.name, app, edit: edit.kind === "import" ? { ...edit, file: resolve(here, edit.file) } : edit };
  const step = run(`Prepare ${app}'s ${edit.kind === "config" ? "configuration" : "secret"} ${edit.key} in the fleet`, [
    process.execPath, within(engine.kayra, "bin", "kayra-app-values.js"), JSON.stringify(input),
  ]);
  return ok<Plan>([step]);
};
