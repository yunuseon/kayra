import { z } from "zod";
import { err, ok } from "../lib/result.ts";
import type { Result } from "../lib/result.ts";
import type { EnvironmentBinding } from "./http-plan.ts";
import { parseRegistrationGeneration } from "./registration-generation.ts";
import type { RegistrationGeneration } from "./registration-generation.ts";

const key = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
const binding = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("literal"), value: z.string().max(65536).refine((value) => !value.includes("\0")) }).strict().readonly(),
  z.object({ kind: z.literal("configuration"), key }).strict().readonly(),
  z.object({ kind: z.literal("secret"), key }).strict().readonly(),
]);
const schema = z.object({ version: z.literal(1), registration: z.unknown(), configurationIdentity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  environment: z.record(key, binding).refine((value) => Object.keys(value).length <= 128).readonly(),
}).strict();
export type ServiceInputs = {
  readonly version: 1;
  readonly registration: RegistrationGeneration;
  readonly configurationIdentity: string;
  readonly environment: Readonly<Record<string, EnvironmentBinding>>;
};
export type RetainedInputsPort = { readonly compare: (previous: ServiceInputs, candidate: ServiceInputs) => Promise<"unchanged" | "changed" | "unavailable"> };
export type RuntimeInputsPort = { readonly materialize: (reference: ServiceInputs) => Promise<Result<Readonly<Record<string, string>>, string>> };
export const parseServiceInputs = (input: unknown) => {
  const checked = schema.safeParse(input); if (!checked.success) return err("invalid service input references");
  const registration = parseRegistrationGeneration(checked.data.registration); if (!registration.ok) return err("invalid service input registration");
  return ok<ServiceInputs>(Object.freeze({ ...checked.data, registration: registration.value }));
};
