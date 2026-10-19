import type { z } from "zod";
import { err, ok } from "../../lib/result.ts";
import { isAnsibleVariable, settings, type ServerKind } from "./settings.ts";
import { closest } from "../../lib/closest.ts";

const suggestion = (key: string, known: readonly string[]) => {
  const name = closest(key, known);
  return name === undefined ? "" : ` — did you mean '${name}'?`;
};

/** The first problem Zod found, said for the file it is in. */
const firstIssue = (file: string, error: z.ZodError, known: readonly string[], unknownKey: string) => {
  const issue = error.issues.at(0);
  if (issue === undefined) return `${file} is invalid`;
  if (issue.code === "unrecognized_keys") {
    const key = issue.keys.at(0) ?? "";
    const where = issue.path.length === 0 ? "" : ` (in ${issue.path.join(".")})`;
    return `${file}: '${key}' ${unknownKey}${where}${issue.path.length === 0 ? suggestion(key, known) : ""}`;
  }
  return `${file}: ${issue.path.length === 0 ? "" : `${issue.path.join(".")}: `}${issue.message}`;
};

const secretNames = settings.filter((each) => each.secret).map((each) => each.name);

/**
 * A settings file (vars.yml, defaults.yml) against its schema: a secret in it
 * is refused first, then unknown keys and wrong types. Ansible's own variables
 * are always allowed.
 */
export const checkSettings = (
  file: string,
  values: Readonly<Record<string, unknown>>,
  schema: z.ZodType,
  known: readonly string[],
) => {
  const leaked = Object.keys(values).find((key) => secretNames.includes(key));
  if (leaked !== undefined) return err(`${file}: '${leaked}' is a secret — it goes in secrets.yml`);
  const own = Object.fromEntries(Object.entries(values).filter(([key]) => !isAnsibleVariable(key)));
  const parsed = schema.safeParse(own);
  return parsed.success ? ok<Readonly<Record<string, unknown>>>(values) : err(firstIssue(file, parsed.error, known, "is not a setting"));
};

/** The names a kind's vars.yml may set. */
export const knownSettings = (kind: ServerKind | undefined) =>
  Object.freeze(settings.filter((each) => !each.secret && (kind === undefined || each.kinds.includes(kind))).map((each) => each.name));

/** A YAML document against a schema, for files whose keys are not settings (app.yml): what the schema makes of it. */
// eslint-disable-next-line functional/prefer-immutable-types -- a Zod schema: immutable once built, but a class the rule cannot see into
export const checkShape = <S extends z.ZodType>(file: string, values: unknown, schema: S) => {
  const parsed = schema.safeParse(values);
  return parsed.success ? ok<z.output<S>>(parsed.data) : err(firstIssue(file, parsed.error, [], "is not a key it knows"));
};
