import { z } from "zod";
import type { InputOf, QueryName } from "../../core/operations/catalog.ts";
import { query, type Context } from "../../core/operations/run.ts";
import { validateJson } from "../../core/commands/validate.ts";
import { parsed, releasesSchema, runsSchema } from "../../core/present/views.ts";
import { err, map, ok, type Result } from "../../result.ts";
import type * as wire from "./contract.gen.ts";

type Answers = { readonly validate: wire.Validation; readonly version: string; readonly "app.runs": wire.AppRuns; readonly "app.releases": wire.AppReleases; readonly "app.log": string };
type Queries = { readonly [N in QueryName]: (context: Context, input: InputOf<N>) => Promise<Result<Answers[N], string>> };
// eslint-disable-next-line functional/prefer-immutable-types -- Zod schemas are immutable; each method returns a new schema
const data = <T>(schema: z.ZodType<T>, text: Result<string, string>): Result<T, string> => {
  if (!text.ok) return text;
  const value = parsed(schema, text.value);
  return value === undefined ? err("the deployer returned an unreadable answer") : ok(value);
};
const queries: Queries = {
  validate: async (context, input) => map(await query(context, "validate", input), validateJson),
  version: (context, input) => query(context, "version", input),
  "app.runs": async (context, input) => data(runsSchema, await query(context, "app.runs", input)),
  "app.releases": async (context, input) => data(releasesSchema, await query(context, "app.releases", input)),
  "app.log": (context, input) => query(context, "app.log", input),
};

export const answer = <N extends QueryName>(context: Context, name: N, input: InputOf<N>): Promise<Result<Answers[N], string>> => queries[name](context, input);
