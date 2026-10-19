import { typed } from "./typed.ts";

/** Edit distance, for "did you mean". */
const indices = (length: number) => typed<readonly number[]>([...Array(length).keys()]);

const distance = (a: string, b: string) =>
  indices(b.length)
    .reduce<readonly number[]>(
      (row, j) =>
        indices(a.length).reduce<readonly number[]>(
          (next, i) => Object.freeze([
            ...next,
            Math.min((row[i + 1] ?? 0) + 1, (next[i] ?? 0) + 1, (row[i] ?? 0) + (a.charAt(i) === b.charAt(j) ? 0 : 1)),
          ]),
          [j + 1],
        ),
      indices(a.length + 1),
    )
    .at(-1) ?? 0;

/** The known name a key is most likely a typo of, if one is close enough. */
export const closest = (key: string, known: readonly string[]) => {
  const nearest = known
    .map((name) => ({ name, cost: distance(key, name) } as const))
    .toSorted((x, y) => x.cost - y.cost)
    .at(0);
  return nearest !== undefined && nearest.cost <= Math.max(2, Math.floor(key.length / 4)) ? nearest.name : undefined;
};
