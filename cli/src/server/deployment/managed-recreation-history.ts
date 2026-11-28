/* eslint-disable functional/no-let -- walks immutable custody links under the caller's bounded evidence window */
import { createHash } from "node:crypto";
import { z } from "zod";
import { lifecycleIndexEntry } from "./lifecycle-app-index-state.ts";
import type { IndexEntry } from "./lifecycle-app-index-state.ts";
import { managedHistorySelection } from "./managed-history-selection.ts";
import { parseManagedLifecycleStore } from "./managed-lifecycle-state.ts";

const archive = z.object({ version: z.literal(1), entry: lifecycleIndexEntry });
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");

/** The new worktree has fresh workload identities but remains bound by every retired data epoch. */
export const validateRecreatedHistory = async (entry: IndexEntry, commit: string, epoch: number,
  ports: { readonly read: (digest: string) => Promise<string>; readonly expired: () => boolean }) => {
  let current = entry;
  const visited = new Set<string>();
  const exact = async (digest: string) => {
    if (ports.expired()) throw new Error("managed recreation history inspection expired");
    const bytes = await ports.read(digest);
    if (ports.expired() || hash(bytes) !== digest) throw new Error("managed recreation history evidence unavailable");
    return bytes;
  };
  while (epoch > 0 && current.lineage !== undefined) {
    const { reservation, archive: identity } = current.lineage;
    if (visited.has(identity)) throw new Error("managed recreation history is cyclic");
    // eslint-disable-next-line functional/immutable-data -- records visited immutable ancestry digests
    visited.add(identity);
    const previous = archive.parse(JSON.parse(await exact(identity))).entry;
    const snapshot = parseManagedLifecycleStore(JSON.parse(await exact(reservation.checkpoint)));
    if (previous.app !== current.app || previous.incarnation !== reservation.predecessor.incarnation ||
      previous.dataOwner !== current.dataOwner || previous.recreation?.request !== reservation.request ||
      JSON.stringify(snapshot.owner) !== JSON.stringify(reservation.predecessor) || snapshot.compatibilityEpoch !== reservation.epoch ||
      snapshot.active?.record !== reservation.release || reservation.epoch > epoch) throw new Error("managed recreation history disagrees");
    const selected = await managedHistorySelection(snapshot, { restore: null, plan: null, commit }, { read: exact, expired: ports.expired }, epoch);
    if ("historical" in selected && selected.historical !== null) throw new Error("managed deployment crosses a retired data compatibility fence");
    current = previous;
  }
};
