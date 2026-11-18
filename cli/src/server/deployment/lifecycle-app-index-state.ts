/* Normalize legacy and managed index records into immutable, validated snapshots. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { names } from "../../lib/names.ts";
import { ownedVolumeSchema, parseDataOwnership } from "../../contracts/owned-volume.ts";
import { parseRegistrationGeneration } from "../../contracts/registration-generation.ts";
import { parseManagedAdmissionAccounting } from "./managed-admission-binding.ts";

const appName = z.string().regex(names.app.pattern);
export const lifecycleIndexEntry = z.object({
  app: appName,
  incarnation: z.uuid(),
  dataOwner: z.uuid().exactOptional(),
  volumes: z.array(ownedVolumeSchema).max(32).default([]).readonly(),
  protocol: z.literal("managed-v3").exactOptional(),
  managedRoot: z.enum(["empty", "ready"]).exactOptional(),
  phase: z.enum(["initializing", "ready"]),
}).strict().refine((owner) => (owner.protocol === "managed-v3") === (owner.managedRoot !== undefined) && (owner.protocol !== "managed-v3" || parseDataOwnership({ version: 1, app: owner.app, incarnation: owner.incarnation, dataOwner: owner.dataOwner }).ok) && owner.volumes.every((volume) => volume.app === owner.app && volume.dataOwner === owner.dataOwner) &&
  new Set(owner.volumes.map((volume) => volume.key)).size === owner.volumes.length &&
  new Set(owner.volumes.map((volume) => volume.allocation)).size === owner.volumes.length).readonly();
export const lifecycleIndexBuild = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  registration: z.object({ version: z.literal(1), app: appName, incarnation: z.uuid(), actionId: z.string(), registrationGeneration: z.uuid() }).strict().readonly(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  deadline: z.number().int().positive(),
  artifact: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
}).strict().readonly();
const schema = z.object({ version: z.literal(1), resources: z.unknown().default(null), managedBindings: z.array(z.unknown()).max(1024).exactOptional(), builds: z.array(lifecycleIndexBuild).default([]).readonly(), apps: z.array(lifecycleIndexEntry).readonly() }).strict().refine(({ apps, builds }) =>
  new Set(apps.map((app) => app.app)).size === apps.length &&
  new Set(apps.map((app) => app.incarnation)).size === apps.length &&
  new Set(apps.flatMap((app) => app.dataOwner === undefined ? Object.freeze([]) : Object.freeze([app.dataOwner]))).size === apps.filter((app) => app.dataOwner !== undefined).length &&
  apps.every((app) => app.dataOwner === undefined || app.dataOwner !== app.incarnation) &&
  new Set(apps.flatMap((app) => Object.freeze(app.volumes.map((volume) => volume.allocation)))).size === apps.reduce((total, app) => total + app.volumes.length, 0) &&
  new Set(builds.map((item) => item.id)).size === builds.length &&
  builds.every((item) => parseRegistrationGeneration(item.registration).ok &&
    apps.some((app) => app.app === item.registration.app && app.incarnation === item.registration.incarnation) &&
    item.id === createHash("sha256").update(JSON.stringify({ registration: item.registration, commit: item.commit })).digest("hex")),
);
export type IndexEntry = z.infer<typeof lifecycleIndexEntry>;

/** One index and one book for legacy and managed workloads. Optional markers keep untouched legacy records in their established shape. */
export const parseLifecycleAppIndex = (input: unknown) => {
  const checked = schema.safeParse(input); if (!checked.success) throw new Error("lifecycle app index is invalid; intervention required");
  const accounting = parseManagedAdmissionAccounting({ resources: checked.data.resources, bindings: checked.data.managedBindings ?? [] });
  if (!accounting.ok) throw new Error("lifecycle resource accounting is invalid; intervention required");
  if (accounting.value.resources?.charges.some((charge) => !checked.data.apps.some((app) => app.app === charge.app && app.incarnation === charge.incarnation)) ||
    accounting.value.bindings.some((binding) => !checked.data.apps.some((app) => app.protocol === "managed-v3" && app.app === binding.owner.app && app.incarnation === binding.owner.incarnation && app.dataOwner === binding.owner.dataOwner)) ||
    accounting.value.resources?.charges.some((charge) => checked.data.apps.some((app) => app.app === charge.app && app.protocol === "managed-v3") && !accounting.value.bindings.some((binding) => binding.owner.app === charge.app))) throw new Error("resource ownership disagrees with app index");
  const { managedBindings, ...data } = checked.data;
  return Object.freeze({ ...data, resources: accounting.value.resources, ...(managedBindings === undefined ? {} : { managedBindings: accounting.value.bindings }) });
};
export type LifecycleAppIndexState = ReturnType<typeof parseLifecycleAppIndex>;
