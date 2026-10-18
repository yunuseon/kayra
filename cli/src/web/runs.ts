import type { RunEvent, RunState, RunSummary } from "./contract.ts";

/** A run as kayra ui keeps it: what it was asked, and everything that happened since, in order. */
export type Run = {
  readonly id: string;
  readonly command: string;
  readonly server?: string;
  readonly started: string;
  readonly events: readonly RunEvent[];
};

/** Sortable by time (an ISO 8601 instant), unique by its tail. */
export const runId = (iso: string, random: string): string => `${iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${random}`;

export const stateOf = (events: readonly RunEvent[]): RunState => {
  const ended = events.findLast((event) => event.kind === "ended");
  if (ended?.kind !== "ended") return "running";
  if (ended.stop?.why === "interrupted") return "interrupted";
  if (ended.stop?.why === "declined") return "declined";
  return ended.failures === 0 ? "passed" : "failed";
};

export const summary = (run: Run): RunSummary => ({
  id: run.id,
  command: run.command,
  ...(run.server === undefined ? {} : { server: run.server }),
  started: run.started,
  state: stateOf(run.events),
});

/** What a run's record holds: the run, then each event, one JSON value per line. */
export const recordLine = (value: Omit<Run, "events"> | RunEvent): string => `${JSON.stringify(value)}\n`;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null;

/** A record as kayra ui wrote it; a run killed mid-write keeps what it had, and what it had says "running". */
export const readRecord = (text: string): Run | undefined => {
  const [head, ...rest] = text
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line): readonly unknown[] => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  if (!isObject(head) || typeof head["id"] !== "string" || typeof head["command"] !== "string" || typeof head["started"] !== "string")
    return undefined;
  // Written by this kayra ui, the lines are its own events.
  const events = rest.filter((each): each is RunEvent => isObject(each) && typeof each["kind"] === "string");
  return {
    id: head["id"],
    command: head["command"],
    ...(typeof head["server"] === "string" ? { server: head["server"] } : {}),
    started: head["started"],
    events,
  };
};

/** A server is busy while a run on it has not ended: one at a time, as on the command line. */
export const busy = (runs: readonly Run[], server: string | undefined): boolean =>
  server !== undefined && runs.some((run) => run.server === server && stateOf(run.events) === "running");
