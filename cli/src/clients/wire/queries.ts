import { schemas } from "./schemas.ts";
import { z } from "zod";
import type { InputOf, QueryName } from "../../core/operations/catalog.ts";
import { query, type Context } from "../../core/operations/dispatch.ts";
import { validateJson } from "./validate.ts";
import { parsed, releasesSchema, runsSchema } from "../../core/ctl/answers.ts";
import { err, map, ok, type Result } from "../../lib/result.ts";
import type * as wire from "./contract.gen.ts";

type WireAnswers = { readonly "app.values": wire.AppValues; readonly validate: wire.Validation; readonly version: string; readonly "app.deployment.status": wire.DeploymentStatus; readonly "app.deployment.health": wire.DeploymentHealth; readonly "app.deployment.pins": wire.DeploymentImagePins; readonly "app.runs": wire.AppRuns; readonly "app.releases": wire.AppReleases; readonly "app.log": string };
type Queries = { readonly [N in QueryName]: (context: Context, input: InputOf<N>) => Promise<Result<WireAnswers[N], string>> };
// eslint-disable-next-line functional/prefer-immutable-types -- Zod schemas are immutable; each method returns a new schema
const data = <T>(schema: z.ZodType<T>, text: Result<string, string>) => {
  if (!text.ok) return text;
  const value = parsed(schema, text.value);
  return value === undefined ? err("the deployer returned an unreadable answer") : ok<T>(value);
};
// eslint-disable-next-line functional/prefer-immutable-types -- the read-only Zod contract validates external data
const scopedData = <T extends { readonly app: string }>(schema: z.ZodType<T>, text: Result<string, string>, app: string) => {
  const result = data(schema, text);
  return !result.ok || result.value.app === app ? result : err("the deployer returned another application's projection");
};
const queries: Queries = {
  "app.values": (context, input) => query(context, "app.values", input),
  validate: async (context, input) => map(await query(context, "validate", input), validateJson),
  version: (context, input) => query(context, "version", input),
  "app.deployment.status": async (context, input) => scopedData(schemas.DeploymentStatus, await query(context, "app.deployment.status", input), input.app),
  "app.deployment.health": async (context, input) => scopedData(schemas.DeploymentHealth, await query(context, "app.deployment.health", input), input.app),
  "app.deployment.pins": async (context, input) => scopedData(schemas.DeploymentImagePins, await query(context, "app.deployment.pins", input), input.app),
  "app.runs": async (context, input) => data(runsSchema, await query(context, "app.runs", input)),
  "app.releases": async (context, input) => data(releasesSchema, await query(context, "app.releases", input)),
  "app.log": (context, input) => query(context, "app.log", input),
};

export const answer = <N extends QueryName>(context: Context, name: N, input: InputOf<N>) => queries[name](context, input);
