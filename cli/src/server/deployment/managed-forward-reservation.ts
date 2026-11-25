import { z } from "zod";
import { parseDataOwnership } from "../../contracts/owned-volume.ts";
import { migrationReasonSchema, parseMigrationResolutionActor } from "../../contracts/migration-resolution.ts";
import { parseRegistrationGeneration } from "../../contracts/registration-generation.ts";

const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.object({ version: z.literal(1), phase: z.literal("initializing"), owner: z.unknown(), run: z.uuid(), action: z.string().max(80), createdAt: time, deadline: time,
  blocked: z.object({ run: z.uuid(), source: digest, checkpoint: digest, compatibilityEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().readonly(),
  selection: z.object({ request: z.uuid(), source: digest, decision: digest }).strict().readonly(),
  build: z.object({ id: digest, artifact: digest, commit: z.string().regex(/^[a-f0-9]{40}$/), registration: z.unknown(), deadline: time }).strict().readonly(),
  candidate: digest, operator: z.unknown(),
}).strict().readonly();

/** Trusted actor comes from the control transport, separately from the public reason and build selection. */
export const managedForwardOperator = (input: unknown) => {
  const raw = z.object({ actor: z.unknown(), reason: migrationReasonSchema }).strict().readonly().parse(input); const actor = parseMigrationResolutionActor(raw.actor);
  if (!actor.ok) throw new Error("invalid forward continuation operator"); return Object.freeze({ ...raw, actor: actor.value });
};

/** Reserved continuation intent only. No cleanup source, runtime effect, ticket completion or admission transfer is implied. */
export const managedForwardReservation = (input: unknown) => {
  const raw = schema.parse(input); const owner = parseDataOwnership(raw.owner); const registration = parseRegistrationGeneration(raw.build.registration);
  if (!owner.ok || !registration.ok || registration.value.app !== owner.value.app || registration.value.incarnation !== owner.value.incarnation || raw.run !== raw.selection.request || raw.run === raw.blocked.run || raw.deadline !== raw.createdAt + 90_000 || !new RegExp(`^${owner.value.incarnation}:[1-9][0-9]*$`).test(raw.action) || !Number.isSafeInteger(Number(raw.action.split(":")[1]))) throw new Error("invalid managed forward reservation scope");
  return Object.freeze({ ...raw, operator: managedForwardOperator(raw.operator), owner: owner.value, build: Object.freeze({ ...raw.build, registration: registration.value }) });
};
export type ManagedForwardReservation = ReturnType<typeof managedForwardReservation>;
