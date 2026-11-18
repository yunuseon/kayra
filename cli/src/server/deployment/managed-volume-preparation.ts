/* eslint-disable functional/no-let -- one serialized, revocable permission scope per catalog reconciliation */
import { z } from "zod";
import type { DataOwnership, OwnedVolumePort } from "../../contracts/owned-volume.ts";
import { ownedVolumeSchema, parseDataOwnership } from "../../contracts/owned-volume.ts";
import type { ManagedVolumePreparation, ManagedVolumePreparationPort } from "../../contracts/managed-volume-preparation.ts";
import { volumeCreationCatalog } from "./volume-creation-catalog.ts";
import type { DataVolumeCreation } from "./data-volume-creation.ts";
import type { OperationJournal } from "./operation.ts";
import { typed } from "../../lib/typed.ts";

const time = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({ owner: z.unknown(), run: z.uuid(), plan: z.string().regex(/^[a-f0-9]{64}$/), createdAt: time, deadline: time, volumes: z.array(ownedVolumeSchema).max(128).readonly() }).strict().readonly();
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
/** Deployment-owned storage preparation. Native volume writes remain typed adapter calls; the parent supplies fresh admission/intent permission at every effect. */
export const managedVolumePreparation = (journal: OperationJournal, owner: DataOwnership, ports: { readonly now: () => number; readonly native: Pick<OwnedVolumePort, "observe" | "create"> }) => {
  let active: { readonly intent: ManagedVolumePreparation; readonly allowed: () => Promise<boolean> } | undefined; let pending = Promise.resolve();
  const permitted = async (creation?: DataVolumeCreation) => {
    const current = active; if (current === undefined || ports.now() < current.intent.createdAt || ports.now() >= current.intent.deadline) return false;
    if (creation !== undefined && (!same(creation.owner, owner) || !current.intent.volumes.some((volume) => same(volume, creation.action.volume)))) return false;
    const allowed = await current.allowed(); return allowed && active === current && ports.now() >= current.intent.createdAt && ports.now() < current.intent.deadline;
  };
  const catalog = volumeCreationCatalog(journal, owner, { ...ports,
    authorize: (creation) => active?.intent.run === creation.action.operation && active.intent.plan === creation.deployment && active.intent.createdAt === creation.createdAt && active.intent.deadline === creation.action.deadline ? permitted(creation) : Promise.resolve(false),
    authorizeReceipt: (creation) => permitted(creation),
    allowRegistration: (candidate, volumes) => same(candidate, owner) && active !== undefined && same(volumes, active.intent.volumes) ? permitted() : Promise.resolve(false),
  });
  const reconcile = async (input: ManagedVolumePreparation, allowed: () => Promise<boolean>) => {
    const raw = schema.parse(input); const ownership = parseDataOwnership(raw.owner);
    if (!ownership.ok || !same(ownership.value, owner) || raw.deadline !== raw.createdAt + 90_000 || new Set(raw.volumes.map((volume) => volume.allocation)).size !== raw.volumes.length || new Set(raw.volumes.map((volume) => volume.key)).size !== raw.volumes.length || raw.volumes.some((volume) => volume.app !== owner.app || volume.dataOwner !== owner.dataOwner)) throw new Error("managed allocation intent disagrees");
    const intent = Object.freeze({ ...raw, owner: ownership.value }); const scope = Object.freeze({ intent, allowed }); active = scope;
    try {
      if (!await permitted()) return "held" as const;
      await catalog.register(intent.volumes);
      for (const volume of intent.volumes) {
        if (!await permitted()) return "held" as const;
        const prepared = await catalog.prepare({ deployment: intent.plan, createdAt: intent.createdAt, action: { volume, operation: intent.run, deadline: intent.deadline } });
        if (prepared.status === "held") return "held" as const;
        if (prepared.status === "waiting") return "pending" as const;
        if (prepared.status === "pending") { const result = await catalog.tick(volume, intent.run); return result.status === "held" ? "held" as const : "pending" as const; }
      }
      return await permitted() ? "ready" as const : "held" as const;
    } finally { if (active === scope) active = undefined; }
  };
  const port = typed<ManagedVolumePreparationPort>({ reconcile: (intent, allowed) => { const result = pending.then(() => reconcile(intent, allowed)); pending = result.then(() => undefined, () => undefined); return result; } });
  return Object.freeze({ ...port, receipts: catalog.receipts });
};
