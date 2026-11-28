import { createHash } from "node:crypto";
import { z } from "zod";
import { managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import { parseManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import type { ManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import { parseManagedRelease } from "./managed-release.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const request = z.object({ restore: digest.nullable(), plan: digest.nullable(), commit: z.string().regex(/^[a-f0-9]{40}$/) }).strict().readonly();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const historyArchive = z.object({ previous: digest.nullable(), state: z.unknown() }).strict().readonly();
const readPrior = (bytes: string, cursor: ManagedLifecycleStore) => {
  const archive = historyArchive.parse(JSON.parse(bytes));
  const prior = parseManagedLifecycleStore(archive.state);
  if (!same(prior.owner, cursor.owner) || archive.previous !== prior.history || prior.sequence >= cursor.sequence || prior.compatibilityEpoch > cursor.compatibilityEpoch) throw new Error("managed restore history disagrees");
  return prior;
};
export const readManagedHistoryRelease = (bytes: string, owner: ManagedLifecycleStore["owner"], pointer: NonNullable<ManagedLifecycleStore["active"]>) => {
  const release = parseManagedRelease(JSON.parse(bytes));
  if (createHash("sha256").update(bytes).digest("hex") !== pointer.record || bytes !== JSON.stringify(release) ||
    !same(release.source.application.infrastructure.ownership, owner) || managedApplicationDigest(release.source.application) !== pointer.plan ||
    release.verification.run !== pointer.run || release.verification.verified?.at !== pointer.verifiedAt) throw new Error("managed compatibility history release disagrees");
  return release;
};
/** Metadata only: a historical commit cannot disguise an old data epoch as a fresh deployment. */
export const managedHistorySelection = async (input: ManagedLifecycleStore, selection: z.input<typeof request>, ports: { readonly read: (digest: string) => Promise<string>; readonly expired: () => boolean }, minimumEpoch = input.compatibilityEpoch) => {
  const current = parseManagedLifecycleStore(input); const selected = request.parse(selection); const owner = current.owner;
  const artifact = async (identity: string) => { const bytes = await ports.read(identity); if (ports.expired()) throw new Error("managed release history inspection expired"); if (createHash("sha256").update(bytes).digest("hex") !== identity) throw new Error("managed release history artifact integrity failed"); return bytes; };
  // eslint-disable-next-line functional/no-let -- walks authenticated decreasing history under the caller's bounded metadata window
  let cursor = current;
  // eslint-disable-next-line functional/no-let -- an old commit match remains forbidden unless the exact plan was subsequently verified in this epoch
  let historical: ManagedLifecycleStore["active"] = null;
  for (;;) {
    if (ports.expired()) throw new Error("managed release history inspection expired");
    const pointers = Object.freeze([cursor.active, ...(cursor.lastGood?.record === cursor.active?.record ? [] : [cursor.lastGood])].filter((item) => item !== null));
    for (const pointer of pointers) {
      if (selected.restore !== null) { if (pointer.record === selected.restore) return pointer; continue; }
      const release = readManagedHistoryRelease(await artifact(pointer.record), owner, pointer);
      const application = release.source.application;
      if (pointer.epoch === minimumEpoch && pointer.plan === selected.plan) return pointer;
      if (pointer.epoch < minimumEpoch && application.commit === selected.commit) historical = pointer;
    }
    if (cursor.history === null) { if (selected.restore !== null) throw new Error("unknown managed restore record"); return Object.freeze({ historical }); }
    cursor = readPrior(await artifact(cursor.history), cursor);
  }
};

/** Offer the most recent distinct verified release in the active data epoch. Admission rechecks the exact record. */
export const previousManagedRelease = async (current: ManagedLifecycleStore, active: ReturnType<typeof parseManagedRelease>, read: (digest: string) => Promise<string>) => {
  if (current.operation.phase !== "complete" || current.active?.epoch !== current.compatibilityEpoch || !active.source.application.rollout.rollback_compatible) return undefined;
  const deadline = performance.now() + 2000;
  // eslint-disable-next-line functional/no-let -- walks a bounded number of immutable archive links
  let cursor = current;
  // eslint-disable-next-line functional/no-let -- cap the number of archived releases inspected
  for (let inspected = 0; inspected < 16; inspected++) {
    if (cursor.history === null || performance.now() >= deadline) return undefined;
    const bytes = await read(cursor.history);
    if (performance.now() >= deadline) return undefined;
    if (createHash("sha256").update(bytes).digest("hex") !== cursor.history) throw new Error("managed release history artifact integrity failed");
    cursor = readPrior(bytes, cursor);
    if (cursor.compatibilityEpoch !== current.compatibilityEpoch) return undefined;
    const pointer = cursor.active;
    if (pointer?.epoch !== current.compatibilityEpoch || pointer.plan === current.active.plan) continue;
    const release = readManagedHistoryRelease(await read(pointer.record), current.owner, pointer);
    const app = release.source.application;
    if (performance.now() >= deadline) return undefined;
    if (app.rollout.rollback_compatible && same(app.infrastructure.registration, active.source.application.infrastructure.registration)) {
      return Object.freeze({ record: pointer.record, commit: app.commit, run: pointer.run, verifiedAt: pointer.verifiedAt });
    }
  }
  return undefined;
};
