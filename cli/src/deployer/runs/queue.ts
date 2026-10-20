import { jobOwner, type AppName, type JobName, type Owner, type RunId } from "../brand.ts";
import { typed } from "../../lib/typed.ts";

/** restore: the deployer bringing back a release that stopped running (restore.ts). */
export type Why = "push" | "poll" | "deploy" | "rollback" | "restore";

/** A job's cron fired, or someone asked for it (`kayra job`, through ctl). */
export type JobWhy = "schedule" | "manual";

export type Work =
  | { readonly kind: "deploy"; readonly app: AppName; readonly ref: string; readonly why: Why }
  | { readonly kind: "job"; readonly job: JobName; readonly dryRun: boolean; readonly why: JobWhy };

/** `id` is the run's, given when it is asked for, so the asker can follow it from the start. */
export type Request = { readonly id: RunId; readonly owner: Owner; readonly work: Work };

export const jobRequest = (id: RunId, job: JobName, dryRun: boolean, why: JobWhy) =>
  typed<Request>({ id, owner: jobOwner(job), work: { kind: "job", job, dryRun, why } });

/** A run's meta.json `what` and `why`. */
export const describe = (request: Request) =>
  Object.freeze({
    what: request.work.kind === "deploy" ? `deploy ${request.work.ref}` : `${request.work.job}${request.work.dryRun ? " (dry run)" : ""}`,
    why: request.work.why,
  });

/**
 * What runs and what waits. One run per owner at a time; a request for an
 * owner that already waits replaces the waiting one (the newest push wins).
 * The registry GC stops the registry, so it runs alone: it waits for
 * everything running, and nothing starts while it runs.
 */
export type Queue = { readonly running: readonly Request[]; readonly waiting: readonly Request[]; readonly limit: number };

export const empty = (limit: number) => typed<Queue>({ running: [], waiting: [], limit });

const exclusive = (request: Request) => request.work.kind === "job" && request.work.job === "gc";

/** Starts what may start, in order; a waiting exclusive request holds back everything behind it. */
const fill = (queue: Queue) => {
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
  return typed<{ readonly queue: Queue; readonly start: readonly Request[] }>({
    queue: { ...queue, running: pick.running, waiting: queue.waiting.filter((request) => !pick.start.includes(request)) },
    start: pick.start,
  });
};

/** Also says which waiting request the new one replaced: that run is superseded, never started. */
export const enqueue = (queue: Queue, request: Request) => {
  const replaced = queue.waiting.filter((waiting) => waiting.owner === request.owner);
  const waiting = replaced.length > 0
    ? queue.waiting.map((waiting) => (waiting.owner === request.owner ? request : waiting))
    : [...queue.waiting, request];
  return typed<{ readonly queue: Queue; readonly start: readonly Request[]; readonly replaced: readonly Request[] }>({ ...fill({ ...queue, waiting }), replaced });
};

export const finish = (queue: Queue, owner: Owner) =>
  fill({ ...queue, running: queue.running.filter((running) => running.owner !== owner) });
