import type * as wire from "./contract.gen.ts";
import type { Run } from "./runs.ts";

/** A run this listener is running: its record so far, who follows it, and what it waits for. */
export type Live = {
  readonly run: Run;
  readonly listeners: readonly ((event: wire.RunEvent) => void)[];
  readonly stop: AbortController;
  readonly answer: ((text: string) => void) | undefined;
  readonly input: ((chunk: string) => void) | undefined;
  readonly done: Promise<unknown>;
};

/**
 * The runs of one listener, in one cell replaced whole: no launch shares
 * locks, credentials or sessions with another.
 */
export const liveRuns = () => {
  // eslint-disable-next-line functional/prefer-immutable-types -- the one state cell of this listener's runs
  const cell: { runs: Readonly<Record<string, Live>> } = { runs: {} };
  return {
    get: (id: string) => cell.runs[id],
    all: () => Object.values(cell.runs),
    /** Installed before any asynchronous work: the run's lock. */
    add: (id: string, live: Live) => {
      // eslint-disable-next-line functional/immutable-data -- replace the one state cell whole
      cell.runs = { ...cell.runs, [id]: live };
    },
    swap: (id: string, change: (live: Live) => Live) => {
      const current = cell.runs[id];
      // eslint-disable-next-line functional/immutable-data -- replace the one state cell whole
      if (current !== undefined) cell.runs = { ...cell.runs, [id]: change(current) };
    },
  } as const;
};

export type LiveRuns = ReturnType<typeof liveRuns>;

/** The requests in flight: shutdown waits for them as well as for the runs. */
export const inFlight = () => {
  // eslint-disable-next-line functional/prefer-immutable-types -- the requests not yet answered
  const cell: { pending: readonly Promise<void>[] } = { pending: [] };
  return {
    track: (work: Promise<void>) => {
      const tracked = work.finally(() => {
        // eslint-disable-next-line functional/immutable-data -- release it once its response completes
        cell.pending = cell.pending.filter((pending) => pending !== tracked);
      });
      // eslint-disable-next-line functional/immutable-data -- one more request in flight
      cell.pending = [...cell.pending, tracked];
      return tracked;
    },
    settled: () => Promise.allSettled(cell.pending),
  } as const;
};
