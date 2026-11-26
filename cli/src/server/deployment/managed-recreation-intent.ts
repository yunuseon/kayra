import { z } from "zod";
import { createHash } from "node:crypto";
import { migrationReasonSchema, parseMigrationResolutionActor } from "../../contracts/migration-resolution.ts";
import { ownedVolumeSchema, parseDataOwnership, volumeReceiptSchema } from "../../contracts/owned-volume.ts";
import type { OwnedVolume } from "../../contracts/owned-volume.ts";
import { parseVolumeCreationCatalog } from "./volume-creation-catalog-state.ts";

const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.object({
  version: z.literal(1),
  request: z.uuid(),
  removal: z.uuid(),
  checkpoint: digest,
  accounting: digest,
  release: digest,
  volumes: digest,
  epoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  predecessor: z.unknown(),
  targetIncarnation: z.uuid(),
  targetGeneration: z.uuid(),
  operator: z.object({ actor: z.unknown(), reason: migrationReasonSchema }).strict().readonly(),
  createdAt: time,
  deadline: time,
  workspace: z.enum(["initializing", "ready"]),
}).strict().readonly();

/** Private custody decision. It references the exact retired predecessor and can never be re-bound to another generation. */
export const managedRecreationIntentSchema = schema.transform((raw, context) => {
  const predecessor = parseDataOwnership(raw.predecessor);
  const actor = parseMigrationResolutionActor(raw.operator.actor);
  if (!predecessor.ok || !actor.ok || raw.request === raw.removal ||
    raw.targetIncarnation === predecessor.value.incarnation || raw.targetIncarnation === predecessor.value.dataOwner ||
    raw.deadline !== raw.createdAt + 90_000) {
    context.addIssue({ code: "custom", message: "managed recreation intent scope disagrees" });
    return z.NEVER;
  }
  return Object.freeze({ ...raw, predecessor: predecessor.value, operator: Object.freeze({ ...raw.operator, actor: actor.value }) });
});
export type ManagedRecreationIntent = z.infer<typeof managedRecreationIntentSchema>;
export const managedRecreationLineageSchema = z.object({
  archive: digest,
  reservation: managedRecreationIntentSchema,
}).strict().readonly().refine((value) => value.reservation.workspace === "ready");

export const managedRecreationRequestSchema = z.object({
  request: z.uuid(),
  removal: z.uuid(),
  generation: z.uuid(),
  reason: migrationReasonSchema,
}).strict().readonly().refine((value) => value.request !== value.removal);

const inventory = z.array(z.object({
  volume: ownedVolumeSchema,
  birth: volumeReceiptSchema.nullable(),
}).strict().readonly()).max(32).readonly();

/** Seed a new catalog from the exact inventory accepted before the old owner was archived. */
export const managedRecreationVolumeCatalog = (bytes: string, intent: ManagedRecreationIntent, expected: readonly OwnedVolume[]) => {
  if (createHash("sha256").update(bytes).digest("hex") !== intent.volumes) throw new Error("managed recreation volume evidence changed");
  const accepted = inventory.parse(JSON.parse(bytes));
  if (JSON.stringify(accepted.map((item) => item.volume)) !== JSON.stringify(expected) ||
    accepted.some(({ volume, birth }) => birth !== null && JSON.stringify(birth.volume) !== JSON.stringify(volume))) {
    throw new Error("managed recreation volume evidence disagrees");
  }
  const owner = { ...intent.predecessor, incarnation: intent.targetIncarnation };
  return parseVolumeCreationCatalog({ version: 1, sequence: 1, owner,
    allocations: accepted.map(({ volume, birth }) => Object.freeze({ volume, creations: Object.freeze([]),
      ...(birth === null ? {} : { inherited: Object.freeze({ from: intent.predecessor, removal: intent.removal, receipt: birth }) }),
    })),
  });
};
