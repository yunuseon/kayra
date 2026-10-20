import { z } from "zod";
import { absolutePath, appNameSchema, fleetRoot, serverNameSchema } from "./core/fleet/brand.ts";
import { loadFleet } from "./core/fleet/load.ts";
import { editSchema } from "./core/app-values/model.ts";
import { editValues } from "./core/app-values/store.ts";
import { err, flatMap } from "./lib/result.ts";

const input = z.strictObject({ root: z.string(), server: serverNameSchema, app: appNameSchema, edit: editSchema, dir: z.string().optional() });
const run = async () => {
  try {
    const request = input.safeParse(JSON.parse(process.argv[2] ?? ""));
    if (!request.success) return err("invalid app values request");
    const { root, server, app, edit, dir } = request.data;
    const fleet = flatMap(absolutePath(root), (path) => loadFleet(fleetRoot(path)));
    if (!fleet.ok) return err("the fleet could not be loaded; run kayra validate");
    const target = fleet.value.servers.find((each) => each.name === server);
    if (target === undefined) return err("server is not in the fleet");
    const directory = dir === undefined ? undefined : absolutePath(dir);
    if (directory !== undefined && !directory.ok) return directory;
    return await editValues(fleet.value.root, target, app, edit, directory?.value);
  } catch {
    // Errors may contain YAML or imported secret text. None reaches a run record.
    return err("app values could not be updated; check file access and vault configuration");
  }
};
const result = await run();
if (result.ok) process.stdout.write(`${result.value}\n`);
else {
  process.stderr.write(`${result.error}\n`);
  // eslint-disable-next-line functional/immutable-data -- exit after flushing diagnostics
  process.exitCode = 1;
}
