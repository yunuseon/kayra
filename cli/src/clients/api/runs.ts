import type { RunEvent, RunState, RunSummary } from "./contract.gen.ts";
import { typed } from "../../typed.ts";

/** A run as kayra keeps it: what it was asked, and everything that happened since, in order. */
export type Run = {
  readonly id: string;
  readonly command: string;
  readonly server?: string;
  readonly started: string;
  readonly events: readonly RunEvent[];
  readonly session: boolean;
};

/** Sortable by time (an ISO 8601 instant), unique by its tail. */
export const runId = (iso: string, random: string) => `${iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${random}`;

export const stateOf = (events: readonly RunEvent[]) => {
  const ended = events.findLast((event) => event.kind === "ended");
  if (ended?.kind !== "ended") return typed<RunState>("running");
  if (ended.stop?.why === "interrupted") return typed<RunState>("interrupted");
  if (ended.stop?.why === "declined") return typed<RunState>("declined");
  return typed<RunState>(ended.failures === 0 ? "passed" : "failed");
};

export const summary = (run: Run) => typed<RunSummary>({
  id: run.id,
  command: run.command,
  ...(run.server === undefined ? {} : { server: run.server }),
  started: run.started,
  session: run.session,
  state: stateOf(run.events),
});

/** What a run's record holds: the run, then each event, one JSON value per line. */
export const recordLine = (value: Omit<Run, "events"> | RunEvent) => `${JSON.stringify(value)}\n`;

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null;

/** A record as kayra wrote it; a run killed mid-write keeps what it had, and what it had says "running". */
export const readRecord = (text: string) => {
  const [head, ...rest] = text
    .split("\n")
    .filter((line) => line !== "")
    .flatMap((line) => {
      try {
        return typed<readonly unknown[]>([JSON.parse(line)]);
      } catch {
        return typed<readonly unknown[]>([]);
      }
    });
  if (!isObject(head) || typeof head["id"] !== "string" || typeof head["command"] !== "string" || typeof head["started"] !== "string")
    return undefined;
  // Written by this kayra, the lines are its own events.
  const events = rest.filter((each): each is RunEvent => isObject(each) && typeof each["kind"] === "string");
  return typed<Run | undefined>({
    id: head["id"],
    command: head["command"],
    ...(typeof head["server"] === "string" ? { server: head["server"] } : {}),
    started: head["started"],
    events,
    session: head["session"] === true,
  });
};

/** A server is busy while a run on it has not ended: one at a time, as on the command line. */
export const busy = (runs: readonly Run[], server: string | undefined) =>
  server !== undefined && runs.some((run) => run.server === server && stateOf(run.events) === "running");
