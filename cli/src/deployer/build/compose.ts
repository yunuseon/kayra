import type { App } from "../app.ts";
import type { Bundle } from "./bundle.ts";
import { wireRoutes } from "./routes.ts";
import { typed } from "../../lib/typed.ts";
import type { Argv } from "../../server/runtime/compose.ts";

export { appFiles, config, imagesFile, routesFile, up, type Argv } from "../../server/runtime/compose.ts";

export const policy = (app: App, script: string, domain: string, bundle: Bundle) =>
  typed<Argv>(["bash", script, app.name, domain, JSON.stringify(wireRoutes(bundle.routes)), ...app.hosts]);
