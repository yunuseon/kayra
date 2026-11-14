import { z } from "zod";
import { names } from "../lib/names.ts";
import { err, ok } from "../lib/result.ts";

export const ownedVolumeKeySchema = z.string().regex(/^[a-z][a-z0-9_-]{0,62}$/);
const identity = z.object({ version: z.literal(1), app: z.string().max(48).regex(names.app.pattern), dataOwner: z.uuid(), allocation: z.uuid(),
  key: ownedVolumeKeySchema, name: z.string(),
}).strict().readonly().superRefine((value, context) => {
  if (value.name !== `kayra-data-${value.allocation}`) context.addIssue({ code: "custom", message: "volume name must identify its durable allocation" });
});
const dataOwnershipSchema = z.object({ version: z.literal(1), app: z.string().regex(names.app.pattern), incarnation: z.uuid(), dataOwner: z.uuid() }).strict().readonly()
  .refine((value) => value.incarnation !== value.dataOwner, "data ownership is distinct from app incarnation");
export type DataOwnership = z.infer<typeof dataOwnershipSchema>;
export const parseDataOwnership = (input: unknown) => {
  const checked = dataOwnershipSchema.safeParse(input);
  return checked.success ? ok<DataOwnership>(checked.data) : err("invalid application data ownership");
};
export const ownedVolumeSchema = identity;
export type OwnedVolume = z.infer<typeof identity>;
export type VolumeAction = { readonly volume: OwnedVolume; readonly operation: string; readonly deadline: number };
export type VolumeReceipt = { readonly volume: OwnedVolume; readonly createdAt: string };
export type VolumeObservation = { readonly status: "absent" | "foreign" | "unavailable" } | { readonly status: "owned"; readonly receipt: VolumeReceipt };
export type VolumeAttachments = { readonly status: "unavailable" } | { readonly status: "observed"; readonly containers: readonly string[]; readonly services: readonly string[] };
export type VolumeWrite = "acknowledged" | "uncertain" | "conflict" | "refused" | "attached";
export type OwnedVolumePort = {
  readonly observe: (volume: OwnedVolume) => Promise<VolumeObservation>;
  readonly attachments: (volume: OwnedVolume) => Promise<VolumeAttachments>;
  readonly create: (action: VolumeAction) => Promise<VolumeWrite>;
  readonly remove: (action: VolumeAction, expected: VolumeReceipt) => Promise<VolumeWrite>;
};

/** Allocation is chosen and persisted by the coordinator, never by a build bundle. */
export const ownedVolume = (app: string, dataOwner: string, allocation: string, key: string) => parseOwnedVolume({ version: 1, app, dataOwner, allocation, key, name: `kayra-data-${allocation}` });
export const parseOwnedVolume = (input: unknown) => {
  const checked = identity.safeParse(input);
  return checked.success ? ok<OwnedVolume>(checked.data) : err("invalid owned volume identity");
};
export const volumeActionSchema = z.object({ volume: identity, operation: z.uuid(), deadline: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().readonly();
