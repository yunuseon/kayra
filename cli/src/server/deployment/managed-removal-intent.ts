import { managedForwardReservation } from "./managed-forward-reservation.ts";
import { z } from "zod";
import { migrationReasonSchema, parseMigrationResolutionActor } from "../../contracts/migration-resolution.ts";
import { ownedVolumeSchema, parseDataOwnership } from "../../contracts/owned-volume.ts";
import { parseRegistrationGeneration } from "../../contracts/registration-generation.ts";

const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({
  version: z.literal(1),
  phase: z.literal("requested"),
  request: z.uuid(),
  ticket: z.string().max(80),
  action: z.string().max(80),
  createdAt: time,
  owner: z.unknown(),
  registration: z.unknown(),
  volumes: z.array(ownedVolumeSchema).max(32).readonly(),
  interruptedForward: z.unknown().optional(),
  operator: z.object({ actor: z.unknown(), reason: migrationReasonSchema }).strict().readonly(),
}).strict().readonly();

/** Private intent. Volume identities are an inventory to preserve, not authority to delete. */
export const parseManagedRemovalIntent = (input: unknown) => {
  const raw = schema.parse(input);
  const ownership = parseDataOwnership(raw.owner);
  const registration = parseRegistrationGeneration(raw.registration);
  const actor = parseMigrationResolutionActor(raw.operator.actor);
  if (!ownership.ok || !registration.ok || !actor.ok) throw new Error("invalid managed removal identity");
  const owner = ownership.value;
  if (registration.value.app !== owner.app || registration.value.incarnation !== owner.incarnation ||
    ![raw.ticket, raw.action].every((value) => new RegExp(`^${owner.incarnation}:[1-9][0-9]*$`).test(value) && Number.isSafeInteger(Number(value.split(":")[1]))) ||
    raw.volumes.some((volume) => volume.app !== owner.app || volume.dataOwner !== owner.dataOwner) ||
    new Set(raw.volumes.map((volume) => volume.key)).size !== raw.volumes.length ||
    new Set(raw.volumes.map((volume) => volume.allocation)).size !== raw.volumes.length) {
    throw new Error("managed removal ownership disagrees");
  }
  const { interruptedForward, ...rest } = raw;
  const interrupted = interruptedForward === undefined ? undefined : managedForwardReservation(interruptedForward);
  if (interrupted !== undefined && (interrupted.phase === "transferring" || JSON.stringify(interrupted.owner) !== JSON.stringify(owner) ||
    Number(interrupted.action.split(":")[1]) >= Number(raw.action.split(":")[1]))) throw new Error("managed removal interrupted continuation disagrees");
  return Object.freeze({ ...rest, ...(interrupted === undefined ? {} : { interruptedForward: interrupted }), owner, registration: registration.value, operator: Object.freeze({ ...raw.operator, actor: actor.value }) });
};
export type ManagedRemovalIntent = ReturnType<typeof parseManagedRemovalIntent>;

export const managedRemovalEffectsReference = z.object({
  version: z.literal(1), request: z.uuid(), action: z.string().max(80),
  inventory: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: time, deadline: time, journal: z.enum(["initializing", "ready"]),
}).strict().readonly().refine((value) => value.deadline === value.createdAt + 90_000);
export type ManagedRemovalEffectsReference = z.infer<typeof managedRemovalEffectsReference>;

const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const managedRemovalAccountingIntent = z.object({
  version: z.literal(1), request: z.uuid(), action: z.string().max(80),
  inventory: digest, effects: digest, before: digest, after: digest, observedAt: time,
}).strict().readonly();
export type ManagedRemovalAccountingIntent = z.infer<typeof managedRemovalAccountingIntent>;
