import { matches, type Cron } from "./cron.ts";

export type Schedules = { readonly poll: Cron; readonly gc: Cron; readonly renovate: Cron | undefined };
export type ScheduledActions = { readonly poll: () => void; readonly gc: () => void; readonly renovate: () => void };

export const tick = (schedules: Schedules, actions: ScheduledActions, at: Date) => {
  if (matches(schedules.poll, at)) actions.poll();
  if (matches(schedules.gc, at)) actions.gc();
  if (schedules.renovate !== undefined && matches(schedules.renovate, at)) actions.renovate();
};

export const schedule = (schedules: Schedules, actions: ScheduledActions) => {
  const wait = 60_000 - (Date.now() % 60_000) + 500;
  setTimeout(() => {
    tick(schedules, actions, new Date());
    schedule(schedules, actions);
  }, wait);
};
