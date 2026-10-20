import { characters, type Line, type Span, width } from "../../core/text/spans.ts";
import type { Milliseconds } from "../../core/fleet/brand.ts";
import { typed } from "../../lib/typed.ts";

/** `left`, then `right` flush with the last column, at least two spaces apart. */
export const spread = (left: Line, right: Line, columns: number) => typed<Line>([
  ...left,
  " ".repeat(Math.max(2, columns - width(left) - width(right))),
  ...right,
]);

/** At most `columns` wide, cut with an ellipsis: a line redrawn in place must not wrap. */
export const truncate = (line: Line, columns: number) => {
  if (width(line) <= columns) return line;
  const cut = line.reduce<{ readonly kept: Line; readonly room: number }>(
    (so, span) => {
      const text = typeof span === "string" ? span : span.text;
      const chars = characters(text);
      const kept = chars.slice(0, Math.max(0, so.room)).join("");
      const piece: Span = typeof span === "string" ? kept : { ...span, text: kept };
      return { kept: kept === "" ? so.kept : [...so.kept, piece], room: so.room - chars.length } as const;
    },
    { kept: [], room: columns - 1 },
  );
  return typed<Line>([...cut.kept, "…"]);
};

/** Words in lines of at most `columns`; a word longer than that gets a line of its own. */
export const wrap = (words: readonly string[], columns: number) =>
  words.reduce<readonly string[]>((lines, word) => {
    const last = lines.at(-1);
    if (last === undefined) return Object.freeze([word]);
    return characters(last).length + 1 + characters(word).length <= columns ? Object.freeze([...lines.slice(0, -1), `${last} ${word}`]) : Object.freeze([...lines, word]);
  }, []);

/** How long ago, as a reader rounds it: 45s ago, 12m ago, 30h ago, 3d ago. */
export const ago = (ms: Milliseconds) => {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${String(hours)}h ago` : `${String(Math.floor(hours / 24))}d ago`;
};

/** A table's rows, each a line per cell. */
export type Rows = readonly (readonly Line[])[];

/** Each column as wide as its widest cell. */
const columnWidths = (rows: Rows) =>
  rows.reduce<readonly number[]>(
    (most, row) => Object.freeze(Array.from({ length: Math.max(most.length, row.length) }, (_, at) => Math.max(most[at] ?? 0, width(row[at] ?? [])))),
    [],
  );

/** Rows of cells in columns as wide as their widest cell, two spaces apart; nothing trails a row's last cell. */
export const table = (rows: Rows) => {
  const filled = rows.map((row) => Object.freeze(row.slice(0, row.findLastIndex((cell) => width(cell) > 0) + 1)));
  const widths = columnWidths(filled);
  return typed<readonly Line[]>(filled.map((row) =>
    Object.freeze(row.flatMap((cell, at) => (at === row.length - 1 ? cell : typed<Line>([...cell, " ".repeat((widths[at] ?? 0) - width(cell) + 2)])))),
  ));
};

/**
 * Rows for table() that fit `room` columns: the cells of the columns in
 * `shrink` cut, in that order, each to no less than its first row's (the
 * heading's) width.
 */
export const fit = (rows: Rows, room: number, shrink: readonly number[]) => {
  const widths = columnWidths(rows);
  const over = widths.reduce((sum, each) => sum + each, 0) + 2 * Math.max(0, widths.length - 1) - room;
  const cut = shrink.reduce<{ readonly widths: readonly number[]; readonly over: number }>(
    (so, at) => {
      const now = so.widths[at] ?? 0;
      const less = Math.min(Math.max(0, so.over), Math.max(0, now - width(rows[0]?.[at] ?? [])));
      return { widths: Object.freeze(so.widths.with(at, now - less)), over: so.over - less } as const;
    },
    { widths, over },
  ).widths;
  return typed<Rows>(rows.map((row) => Object.freeze(row.map((cell, at) => truncate(cell, cut[at] ?? width(cell))))));
};

/** Paths by the root they are under, the longest first: the engine may live inside the fleet. */
export const shortener =
  (roots: readonly (readonly [string, string])[]) =>
  (text: string) =>
    roots.toSorted(([a], [b]) => b.length - a.length).reduce((short, [path, name]) => short.replaceAll(path, name), text);
