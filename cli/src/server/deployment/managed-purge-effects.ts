import type { OwnedVolumePort } from "../../contracts/owned-volume.ts";
import { parseManagedPurge } from "./managed-purge-state.ts";
import type { ManagedPurge } from "./managed-purge-state.ts";

export type ManagedPurgeEffectsPorts = {
  readonly now: () => number;
  readonly native: Pick<OwnedVolumePort, "observe" | "attachments" | "remove">;
  /** The owning index checks the settlement, exact unregistered generation and operator grant. */
  readonly allowed: () => Promise<boolean>;
  readonly persist: (next: ManagedPurge) => Promise<ManagedPurge>;
};
type Entry = ManagedPurge["entries"][number];
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

type VolumeRead = Readonly<Pick<OwnedVolumePort, "observe" | "attachments">>;
type VolumeEvidence = "owned" | "absent" | "runtime" | "ownership" | "attachments";

export const inspectManagedPurgeVolume = async (entry: Pick<Entry, "volume" | "birth">, ports: VolumeRead): Promise<VolumeEvidence> => {
  const owned = await ports.observe(entry.volume);
  if (owned.status === "unavailable") return "runtime";
  if (owned.status === "foreign" || owned.status === "owned" && !same(owned.receipt, entry.birth)) return "ownership";
  const attachments = await ports.attachments(entry.volume);
  if (attachments.status !== "observed") return "runtime";
  if (attachments.containers.length !== 0 || attachments.services.length !== 0) return "attachments";
  return owned.status === "owned" ? "owned" : "absent";
};

/** One bounded reconciliation step. The app writer must span observation, intent and dispatch. */
export const reconcileManagedPurge = async (input: ManagedPurge, ports: ManagedPurgeEffectsPorts) => {
  const state = parseManagedPurge(input);
  if (state.phase === "complete" || state.phase === "held") return state;
  const timely = () => Number.isSafeInteger(ports.now()) && ports.now() >= state.createdAt && ports.now() < state.deadline;
  const bounded = async <T>(call: () => Promise<T>) => {
    if (!timely()) return undefined;
    const elapsed = Promise.withResolvers<undefined>();
    const timer = setTimeout(() => { elapsed.resolve(undefined); }, Math.min(10_000, state.deadline - ports.now()));
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), elapsed.promise]); }
    finally { clearTimeout(timer); }
  };
  const hold = (reason: NonNullable<ManagedPurge["reason"]>) =>
    ports.persist(Object.freeze({ ...state, phase: "held", reason }));
  const persistEntry = (entry: Entry, phase: Entry["phase"]) =>
    ports.persist(Object.freeze({ ...state, entries: Object.freeze(state.entries.map((known) => known === entry ? Object.freeze({ ...entry, phase }) : known)) }));

  const preflight = async (entry: Entry) =>
    await bounded(() => inspectManagedPurgeVolume(entry, ports.native)) ?? "runtime";

  if (!timely()) return hold("deadline");
  if (await bounded(ports.allowed) !== true) return hold(timely() ? "registration" : "deadline");
  if (state.phase === "preflight") {
    const checks = await Promise.all(state.entries.map(preflight));
    const problem = checks.find((value) => value !== "owned" && value !== "absent");
    if (!timely()) return hold("deadline");
    if (problem !== undefined) return problem === "runtime" ? state : hold(problem);
    return ports.persist(Object.freeze({ ...state, phase: "deleting" }));
  }
  const entry = state.entries.find((entry) => entry.phase === "deleting") ?? state.entries.find((entry) => entry.phase === "pending");
  if (entry === undefined) {
    const results = await Promise.all(state.entries.map(preflight));
    if (!timely()) return hold("deadline");
    if (results.includes("attachments")) return hold("attachments");
    if (results.some((result) => result === "ownership" || result === "owned")) return hold("ownership");
    if (results.includes("runtime")) return state;
    return ports.persist(Object.freeze({ ...state, phase: "complete", finishedAt: ports.now() }));
  }
  const observed = await preflight(entry);
  if (!timely()) return hold("deadline");
  if (observed === "runtime") return state;
  if (observed === "absent") return persistEntry(entry, "absent");
  if (observed !== "owned" || entry.birth === null) return hold(observed === "owned" ? "ownership" : observed);
  if (entry.phase === "pending") return persistEntry(entry, "deleting");
  if (await bounded(ports.allowed) !== true || !timely()) return hold(timely() ? "registration" : "deadline");
  const birth = entry.birth;
  const result = await bounded(() => ports.native.remove({ volume: entry.volume, operation: state.request, deadline: state.deadline }, birth));
  if (result === "attached") return hold("attachments");
  if (result === "refused" || result === "conflict") return hold("ownership");
  // An observed absence seals either a successful delete or a lost acknowledgement.
  return state;
};
