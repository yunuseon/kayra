import { all, err, map, ok } from "../result.ts";

/** A standard five-field cron spec, in the server's local time. */
export type Cron = {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly day: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly weekday: ReadonlySet<number>;
  /** Cron's quirk: with both restricted, a day matching either one is enough. */
  readonly eitherDay: boolean;
};

const range = (from: number, to: number, step: number) =>
  Object.freeze(Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step));

const part = (text: string, min: number, max: number) => {
  const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(text);
  if (match === null) return err(`'${text}'`);
  const [, whole, low, high, every] = match;
  const step = every === undefined ? 1 : Number(every);
  const from = whole === "*" ? min : Number(low);
  const to = whole === "*" ? max : high === undefined ? (every === undefined ? from : max) : Number(high);
  return from < min || to > max || from > to || step < 1 ? err(`'${text}' (${String(min)}-${String(max)})`) : ok<readonly number[]>(range(from, to, step));
};

const values = (text: string, min: number, max: number) =>
  map(all(text.split(",").map((piece) => part(piece, min, max))), (parts) => Object.freeze(new Set(parts.flat())));

export const parseCron = (spec: string) => {
  const fields = spec.trim().split(/\s+/);
  const [minute, hour, day, month, weekday] = fields;
  if (fields.length !== 5 || minute === undefined || hour === undefined || day === undefined || month === undefined || weekday === undefined) {
    return err(`'${spec}' is not a five-field cron spec`);
  }
  const parsed = all([values(minute, 0, 59), values(hour, 0, 23), values(day, 1, 31), values(month, 1, 12), values(weekday, 0, 7)]);
  if (!parsed.ok) return err(`'${spec}': ${parsed.error}`);
  const [minutes, hours, days, months, weekdays] = parsed.value;
  if (minutes === undefined || hours === undefined || days === undefined || months === undefined || weekdays === undefined) {
    return err(`'${spec}' is not a five-field cron spec`);
  }
  return ok<Cron>({
    minute: minutes,
    hour: hours,
    day: days,
    month: months,
    // 7 is Sunday too.
    weekday: new Set([...weekdays].map((d) => d % 7)),
    eitherDay: day !== "*" && weekday !== "*",
  });
};

export const matches = (cron: Cron, at: Date) => {
  const day = cron.day.has(at.getDate());
  const weekday = cron.weekday.has(at.getDay());
  return (
    cron.minute.has(at.getMinutes()) &&
    cron.hour.has(at.getHours()) &&
    cron.month.has(at.getMonth() + 1) &&
    (cron.eitherDay ? day || weekday : day && weekday)
  );
};
