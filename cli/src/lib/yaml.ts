import { parseDocument } from "yaml";
import { err, ok } from "./result.ts";
import { typed } from "./typed.ts";

export type Fields = Readonly<Record<string, unknown>>;

export const mapping = (value: unknown) =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? typed<Fields>(Object.fromEntries(Object.entries(value))) : undefined;

/** YAML text as a value; a syntax error is a value too, not an exception. */
export const yamlOf = (text: string) => {
  const document = parseDocument(text);
  const problem = document.errors.at(0);
  return problem === undefined ? ok<unknown>(document.toJS()) : err(`is not valid YAML: ${problem.message.split("\n")[0] ?? ""}`);
};

/** YAML text as a mapping; empty for an empty file. */
export const fields = (text: string) => {
  const parsed = yamlOf(text);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (value === null || value === undefined) return ok<Fields>({});
  const result = mapping(value);
  return result === undefined ? err("is not a YAML mapping") : ok<Fields>(result);
};
