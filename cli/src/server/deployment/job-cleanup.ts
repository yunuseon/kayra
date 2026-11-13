import { createHash } from "node:crypto";
import { parseJobCleanupPlan, parseJobCleanupState } from "../../contracts/job-cleanup.ts";
import type { JobCleanupPlan, JobCleanupPort, JobCleanupState } from "../../contracts/job-cleanup.ts";
import { jobPlanDigest, parseJobPlan } from "../../contracts/one-shot-job.ts";
import { claimJournal } from "./journal-claim.ts";
import type { OperationJournal } from "./operation.ts";

type Ports = { readonly native: JobCleanupPort; readonly now: () => number; readonly read: (digest: string) => Promise<string>;
  readonly authorize: (state: JobCleanupState) => Promise<boolean> };

/** Private child of an audited lifecycle operation. Original execution evidence and deadlines stay untouched. */
export const jobCleanup = (journal: OperationJournal, ports: Ports) => {
  claimJournal(journal, "journal already has a cleanup owner");
  // eslint-disable-next-line functional/no-let -- serializes the parent's private cleanup transitions
  let pending = Promise.resolve();
  const serial = <T>(call: () => Promise<T>) => { const result = pending.then(call); pending = result.then(() => undefined, () => undefined); return result; };
  const load = async () => { const raw = await journal.read(); return raw === undefined ? undefined : parseJobCleanupState(raw); };
  const required = async () => { const state = await load(); if (state === undefined) throw new Error("job cleanup intent is missing"); return state; };
  const write = async (input: JobCleanupState) => { const state = parseJobCleanupState(input); await journal.write(state); return state; };
  const time = (state: JobCleanupState) => { const now = ports.now(); if (!Number.isSafeInteger(now) || now < state.authority.createdAt) throw new Error("job cleanup clock is unavailable"); return now; };
  const hold = (state: JobCleanupState) => write({ ...state, phase: "held" });
  return Object.freeze({
    prepare: (input: JobCleanupPlan) => serial(async () => {
      const authority = parseJobCleanupPlan(input); if (!authority.ok) throw new Error(authority.error);
      const existing = await load();
      if (existing !== undefined) {
        if (JSON.stringify(existing.authority) !== JSON.stringify(authority.value)) throw new Error("job cleanup authority changed"); return existing;
      }
      const state = parseJobCleanupState({ version: 1, authority: authority.value, phase: "fencing", targets: [], barrier: null, completedAt: null });
      if (time(state) >= state.authority.deadline) throw new Error("job cleanup authority has expired");
      return write(state);
    }),
    read: () => serial(load),
    tick: () => serial(async () => {
      const state = await required(); if (state.phase !== "fencing") return state;
      if (time(state) >= state.authority.deadline) return hold(state);
      const bytes = await ports.read(state.authority.job); const parsed = parseJobPlan(JSON.parse(bytes));
      if (!parsed.ok || createHash("sha256").update(bytes).digest("hex") !== state.authority.job || jobPlanDigest(parsed.value) !== state.authority.job) throw new Error("job cleanup artifact integrity failed");
      const observed = await ports.native.observe(parsed.value); const now = time(state);
      if (now >= state.authority.deadline || observed.status === "foreign" || observed.status === "owned" && observed.plan !== state.authority.job) return hold(state);
      if (observed.status === "unavailable") return state;
      if (observed.status === "owned" && observed.barrier) return observed.state === "created" && !state.targets.includes(observed.id)
        ? write({ ...state, phase: "complete", barrier: observed.id, completedAt: now }) : hold(state);
      if (observed.status === "owned" && !state.targets.includes(observed.id) && state.targets.length >= 8) return hold(state);
      const next = observed.status === "owned" && !state.targets.includes(observed.id) ? await write({ ...state, targets: [...state.targets, observed.id] }) : state;
      if (!(await ports.authorize(next))) return hold(next);
      if (time(next) >= next.authority.deadline) return hold(next);
      await ports.native.fence(parsed.value, next.authority, observed.status === "owned" ? observed.id : null);
      return next;
    }),
  });
};
