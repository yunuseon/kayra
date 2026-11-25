import { createHash } from "node:crypto";
import { z } from "zod";
import { managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import { parseManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import type { ManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import { parseManagedRelease } from "./managed-release.ts";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const request = z.object({ restore: digest.nullable(), plan: digest.nullable(), commit: z.string().regex(/^[a-f0-9]{40}$/) }).strict().readonly();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Metadata only: a historical commit cannot disguise an old data epoch as a fresh deployment. */
export const managedHistorySelection = async (input: ManagedLifecycleStore, selection: z.input<typeof request>, ports: { readonly read: (digest: string) => Promise<string>; readonly expired: () => boolean }) => {
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
      const bytes = await artifact(pointer.record); const release = parseManagedRelease(JSON.parse(bytes)); const application = release.source.application;
      if (bytes !== JSON.stringify(release) || !same(application.infrastructure.ownership, owner) || managedApplicationDigest(application) !== pointer.plan || release.verification.run !== pointer.run || release.verification.verified?.at !== pointer.verifiedAt) throw new Error("managed compatibility history release disagrees");
      if (pointer.epoch === current.compatibilityEpoch && pointer.plan === selected.plan) return pointer;
      if (pointer.epoch < current.compatibilityEpoch && application.commit === selected.commit) historical = pointer;
    }
    if (cursor.history === null) { if (selected.restore !== null) throw new Error("unknown managed restore record"); return Object.freeze({ historical }); }
    const bytes = await artifact(cursor.history); const archive = z.object({ previous: digest.nullable(), state: z.unknown() }).strict().parse(JSON.parse(bytes)); const prior = parseManagedLifecycleStore(archive.state);
    if (!same(prior.owner, owner) || archive.previous !== prior.history || prior.sequence >= cursor.sequence || prior.compatibilityEpoch > cursor.compatibilityEpoch) throw new Error("managed restore history disagrees"); cursor = prior;
  }
};
