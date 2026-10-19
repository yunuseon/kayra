import type { z } from "zod";
import { err, ok } from "./result.ts";

/** A schema as a constructor: its value, or the first problem it found. */
// eslint-disable-next-line functional/prefer-immutable-types -- a Zod schema: immutable once built, but a class the rule cannot see into
export const minting = <S extends z.ZodType>(schema: S) => (value: z.input<S>) => {
  const parsed = schema.safeParse(value);
  return parsed.success ? ok<z.output<S>>(parsed.data) : err(parsed.error.issues.at(0)?.message ?? "is invalid");
};
