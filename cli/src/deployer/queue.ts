import type { AppName, JobName, Owner } from "./brand.ts";

export type Why = "push" | "poll" | "deploy" | "rollback";

export type Work =
  | { readonly kind: "deploy"; readonly app: AppName; readonly ref: string; readonly why: Why }
  | { readonly kind: "job"; readonly job: JobName; readonly dryRun: boolean };

export type Request = { readonly owner: Owner; readonly work: Work };

/**
 * What runs and what waits. One run per owner at a time; a request for an
 * owner that already waits replaces the waiting one (the newest push wins, as
 * Jenkins' disableConcurrentBuilds coalesced). The registry GC stops the
 * registry, so it runs alone: it waits for everything running, and nothing
 * starts while it runs.
 */
export type Queue = { readonly running: readonly Request[]; readonly waiting: readonly Request[]; readonly limit: number };

export const empty = (limit: number): Queue => ({ running: [], waiting: [], limit });

const exclusive = (request: Request): boolean => request.work.kind === "job" && request.work.job === "gc";

/** Starts what may start, in order; a waiting exclusive request holds back everything behind it. */
const fill = (queue: Queue): { readonly queue: Queue; readonly start: readonly Request[] } => {
  const pick = queue.waiting.reduce<{ readonly running: readonly Request[]; readonly blocked: boolean; readonly start: readonly Request[] }>(
    (so, request) => {
      if (so.blocked || so.running.some(exclusive)) return { ...so, blocked: true };
      if (exclusive(request)) {
        return so.running.length === 0
          ? { running: [request], blocked: true, start: [...so.start, request] }
          : { ...so, blocked: true };
      }
      const free = so.running.length < queue.limit && !so.running.some((running) => running.owner === request.owner);
      return free ? { ...so, running: [...so.running, request], start: [...so.start, request] } : so;
    },
    { running: queue.running, blocked: false, start: [] },
  );
  return {
    queue: { ...queue, running: pick.running, waiting: queue.waiting.filter((request) => !pick.start.includes(request)) },
    start: pick.start,
  };
};

export const enqueue = (queue: Queue, request: Request): { readonly queue: Queue; readonly start: readonly Request[] } => {
  const waits = queue.waiting.some((waiting) => waiting.owner === request.owner);
  const waiting = waits
    ? queue.waiting.map((waiting) => (waiting.owner === request.owner ? request : waiting))
    : [...queue.waiting, request];
  return fill({ ...queue, waiting });
};

export const finish = (queue: Queue, owner: Owner): { readonly queue: Queue; readonly start: readonly Request[] } =>
  fill({ ...queue, running: queue.running.filter((running) => running.owner !== owner) });
