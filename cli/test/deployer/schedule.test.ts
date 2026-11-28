import { deepStrictEqual } from "node:assert/strict";
import { test } from "node:test";
import { parseCron } from "../../src/server/platform/cron.ts";
import { tick } from "../../src/server/platform/schedule.ts";

const cron = (spec: string) => {
  const result = parseCron(spec);
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

test("platform scheduler invokes only due actions, leaving the queue to its caller", () => {
  // eslint-disable-next-line functional/prefer-immutable-types -- record the actions invoked by the scheduler
  const calls: string[] = [];
  const actions = {
    poll: () => {
      // eslint-disable-next-line functional/immutable-data -- record this action
      calls.push("poll");
    },
    gc: () => {
      // eslint-disable-next-line functional/immutable-data -- record this action
      calls.push("gc");
    },
    renovate: () => {
      // eslint-disable-next-line functional/immutable-data -- record this action
      calls.push("renovate");
    },
  };
  const schedules = { poll: cron("17 * * * *"), gc: cron("0 3 * * *"), renovate: cron("0 4 * * 1") };
  tick(schedules, actions, new Date(2026, 9, 26, 4, 0));
  deepStrictEqual(calls, ["renovate"]);
  tick(schedules, actions, new Date(2026, 9, 26, 4, 17));
  deepStrictEqual(calls, ["renovate", "poll"]);
  tick({ ...schedules, renovate: undefined }, actions, new Date(2026, 9, 26, 3, 0));
  deepStrictEqual(calls, ["renovate", "poll", "gc"]);
});
