import type { z } from "zod";
import { err, ok, type Result } from "../../result.ts";
import { isAnsibleVariable, settings, type ServerKind } from "./settings.ts";

/** Edit distance, for "did you mean". */
const indices = (length: number): readonly number[] => [...Array(length).keys()];

const distance = (a: string, b: string): number =>
  indices(b.length)
    .reduce<readonly number[]>(
      (row, j) =>
        indices(a.length).reduce<readonly number[]>(
          (next, i) => [
            ...next,
            Math.min((row[i + 1] ?? 0) + 1, (next[i] ?? 0) + 1, (row[i] ?? 0) + (a.charAt(i) === b.charAt(j) ? 0 : 1)),
          ],
          [j + 1],
        ),
      indices(a.length + 1),
    )
    .at(-1) ?? 0;

/** The known name a key is most likely a typo of, if one is close enough. */
export const closest = (key: string, known: readonly string[]): string | undefined => {
  const nearest = known
    .map((name) => ({ name, cost: distance(key, name) }))
    .toSorted((x, y) => x.cost - y.cost)
    .at(0);
  return nearest !== undefined && nearest.cost <= Math.max(2, Math.floor(key.length / 4)) ? nearest.name : undefined;
};

const suggestion = (key: string, known: readonly string[]): string => {
  const name = closest(key, known);
  return name === undefined ? "" : ` — did you mean '${name}'?`;
};

/** The first problem Zod found, said for the file it is in. */
const firstIssue = (file: string, error: z.ZodError, known: readonly string[], unknownKey: string): string => {
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
): Result<Readonly<Record<string, unknown>>, string> => {
  const leaked = Object.keys(values).find((key) => secretNames.includes(key));
  if (leaked !== undefined) return err(`${file}: '${leaked}' is a secret — it goes in secrets.yml`);
  const own = Object.fromEntries(Object.entries(values).filter(([key]) => !isAnsibleVariable(key)));
  const parsed = schema.safeParse(own);
  return parsed.success ? ok(values) : err(firstIssue(file, parsed.error, known, "is not a setting"));
};

/** The names a kind's vars.yml may set. */
export const knownSettings = (kind: ServerKind | undefined): readonly string[] =>
  settings.filter((each) => !each.secret && (kind === undefined || each.kinds.includes(kind))).map((each) => each.name);

/** A YAML document against a schema, for files whose keys are not settings (server.yml, app.yml). */
export const checkShape = (file: string, values: unknown, schema: z.ZodType): Result<unknown, string> => {
  const parsed = schema.safeParse(values);
  return parsed.success ? ok(values) : err(firstIssue(file, parsed.error, [], "is not a key it knows"));
};
