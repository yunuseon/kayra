import { z } from "zod";
import { err, ok } from "../lib/result.ts";

const schema = z.object({ version: z.literal(1), outcome: z.enum(["applied", "not-applied", "unknown"]) }).strict().readonly();
export type MigrationProbe = z.infer<typeof schema>;

/** Only a bounded, complete app response is semantic evidence. Diagnostics never echo its bytes. */
export const parseMigrationProbe = (input: string) => {
  if (input.length > 256 || new TextEncoder().encode(input).length > 256) return err("invalid migration probe response");
  try {
    const value: unknown = JSON.parse(input); const parsed = schema.safeParse(value);
    return parsed.success ? ok<MigrationProbe>(parsed.data) : err("invalid migration probe response");
  } catch { return err("invalid migration probe response"); }
};
