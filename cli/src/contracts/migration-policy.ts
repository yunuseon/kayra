import { z } from "zod";
import { err, ok } from "../lib/result.ts";

const schema = z.object({ version: z.literal(1), migrationTimeoutCeilingSeconds: z.number().int().min(1).max(86400) }).strict().readonly();
export type MigrationPolicy = z.infer<typeof schema>;

/** Operator policy only; app declarations cannot increase the host's execution ceiling. */
export const parseMigrationPolicy = (input: unknown) => {
  const parsed = schema.safeParse(input);
  return parsed.success ? ok<MigrationPolicy>(parsed.data) : err("invalid host migration policy");
};
