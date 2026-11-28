import type { EnvironmentBinding } from "../../contracts/http-plan.ts";
import { all, err, ok } from "../../lib/result.ts";

export const environmentBindings = (environment: Readonly<Record<string, string>>, configuration: readonly string[], secrets: readonly string[]) => all(Object.entries(environment).map(([name, value]) => {
  const reference = /^\$\{([A-Z][A-Z0-9_]{0,127})(?::\?[^}]*)?\}$/.exec(value);
  if (reference?.[1] !== undefined) {
    const key = reference[1];
    if (configuration.includes(key)) return ok<readonly [string, EnvironmentBinding]>([name, Object.freeze({ kind: "configuration", key })]);
    if (secrets.includes(key)) return ok<readonly [string, EnvironmentBinding]>([name, Object.freeze({ kind: "secret", key })]);
    return err("environment references undeclared configuration or secret input");
  }
  const literal = value.replaceAll("$$", "\0");
  if (literal.includes("$")) return err("only literal environment values and exact declared input references are supported");
  return ok<readonly [string, EnvironmentBinding]>([name, Object.freeze({ kind: "literal", value: literal.replaceAll("\0", "$") })]);
}));
