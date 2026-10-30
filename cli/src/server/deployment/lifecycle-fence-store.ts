/* A trusted composition root gives this store exclusive ownership of its journal. */
/* eslint-disable functional/prefer-immutable-types */
import type { OperationJournal } from "./operation.ts";
import {
  beginRegistration, beginLifecycleRegistration, beginLifecycleWork, completeLifecyclePurge,
  completeLifecycleRemoval, parseLifecycleFence, requestLifecycleRemoval, settleLifecycleWork,
  startLifecyclePurge, startLifecycleRemoval,
} from "./lifecycle-fence.ts";

const claimed = new WeakSet<OperationJournal>();

/**
 * Disconnected persistence primitive. It serializes transitions and persists each
 * before acknowledging it. It does not authenticate completion evidence, fence
 * any host writer, or prove volume ownership. The owner must not write directly
 * through the journal handle and must reconcile every interrupted effect.
 */
export const openLifecycleFenceStore = (journal: OperationJournal) => {
  if (claimed.has(journal)) throw new Error("lifecycle journal is already owned");
  claimed.add(journal);
  // eslint-disable-next-line functional/no-let -- serialize reads and writes on the exclusive handle
  let pending = Promise.resolve();
  // eslint-disable-next-line functional/no-let -- uncertain writes must not be followed by new effects
  let poisoned = false;
  const serial = <T>(operation: () => Promise<T>) => {
    const result = pending.then(() => {
      if (poisoned) throw new Error("lifecycle write outcome is uncertain; reopen and reconcile");
      return operation();
    });
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
  const read = async () => {
    const raw = await journal.read();
    if (raw === undefined) return undefined;
    const parsed = parseLifecycleFence(raw);
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.value;
  };
  const write = async (state: ReturnType<typeof parseLifecycleFence>) => {
    if (!state.ok) throw new Error(state.error);
    try {
      await journal.write(state.value);
      return state.value;
    } catch (error) {
      poisoned = true;
      throw error;
    }
  };
  const change = (apply: (state: NonNullable<Awaited<ReturnType<typeof read>>>) => ReturnType<typeof parseLifecycleFence>) => serial(async () => {
    const state = await read();
    if (state === undefined) throw new Error("lifecycle fence has not been initialized");
    return write(apply(state));
  });
  return {
    read: () => serial(read),
    initialize: (app: string, generation: string) => serial(async () => {
      const state = await read();
      if (state !== undefined) {
        if (state.app === app && state.generation === generation && state.lifecycle.phase === "registering" && state.lifecycle.active.sequence === 1 && state.nextAction === 2) return state;
        throw new Error("lifecycle fence is already initialized");
      }
      return write(beginRegistration(app, generation));
    }),
    beginRegistration: () => change(beginLifecycleRegistration),
    beginWork: (kind: "deploy" | "restore") => change((state) => beginLifecycleWork(state, kind)),
    settle: (actionId: string) => change((state) => settleLifecycleWork(state, actionId)),
    requestRemoval: () => change(requestLifecycleRemoval),
    startRemoval: (observeOwnedVolumes: () => Promise<readonly string[]>) => serial(async () => {
      const state = await read();
      if (state?.lifecycle.phase !== "removal-requested" || state.lifecycle.active !== null) throw new Error("removal cannot start until prior work is settled");
      const volumes = await observeOwnedVolumes();
      if (!Array.isArray(volumes) || volumes.length > 128) throw new Error("invalid volume identities");
      const length = volumes.length;
      const copy: string[] = [];
      // eslint-disable-next-line functional/no-let -- reject missing indexed elements
      for (let index = 0; index < length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(volumes, String(index));
        const value: unknown = descriptor?.value;
        if (descriptor === undefined || !Object.hasOwn(descriptor, "value") || typeof value !== "string") throw new Error("invalid volume identities");
        // eslint-disable-next-line functional/immutable-data -- local snapshot has not escaped
        copy.push(value);
      }
      if (volumes.length !== length) throw new Error("invalid volume identities");
      const snapshot = Object.freeze(copy);
      return write(startLifecycleRemoval(state, snapshot));
    }),
    completeRemoval: (actionId: string) => change((state) => completeLifecycleRemoval(state, actionId)),
    startPurge: (removalId: string) => change((state) => startLifecyclePurge(state, removalId)),
    completePurge: (actionId: string) => change((state) => completeLifecyclePurge(state, actionId)),
  };
};
