import { characters, type Line, type Span, width } from "../../core/text/spans.ts";

/** `left`, then `right` flush with the last column, at least two spaces apart. */
export const spread = (left: Line, right: Line, columns: number): Line => [
  ...left,
  " ".repeat(Math.max(2, columns - width(left) - width(right))),
  ...right,
];

/** At most `columns` wide, cut with an ellipsis: a line redrawn in place must not wrap. */
export const truncate = (line: Line, columns: number): Line => {
  if (width(line) <= columns) return line;
  const cut = line.reduce<{ readonly kept: Line; readonly room: number }>(
    (so, span) => {
      const text = typeof span === "string" ? span : span.text;
      const chars = characters(text);
      const kept = chars.slice(0, Math.max(0, so.room)).join("");
      const piece: Span = typeof span === "string" ? kept : { ...span, text: kept };
      return { kept: kept === "" ? so.kept : [...so.kept, piece], room: so.room - chars.length };
    },
    { kept: [], room: columns - 1 },
  );
  return [...cut.kept, "…"];
};

/** Words in lines of at most `columns`; a word longer than that gets a line of its own. */
export const wrap = (words: readonly string[], columns: number): readonly string[] =>
  words.reduce<readonly string[]>((lines, word) => {
    const last = lines.at(-1);
    if (last === undefined) return [word];
    return characters(last).length + 1 + characters(word).length <= columns ? [...lines.slice(0, -1), `${last} ${word}`] : [...lines, word];
  }, []);

/** How long ago, as a reader rounds it: 45s ago, 12m ago, 30h ago, 3d ago. */
export const ago = (ms: number): string => {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${String(seconds)}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${String(hours)}h ago` : `${String(Math.floor(hours / 24))}d ago`;
};

/** Rows of cells in columns as wide as their widest cell, two spaces apart; nothing trails a row's last cell. */
/** Each column as wide as its widest cell. */
const columnWidths = (rows: readonly (readonly Line[])[]): readonly number[] =>
  rows.reduce<readonly number[]>(
    (most, row) => Array.from({ length: Math.max(most.length, row.length) }, (_, at) => Math.max(most[at] ?? 0, width(row[at] ?? []))),
    [],
  );

export const table = (rows: readonly (readonly Line[])[]): readonly Line[] => {
  const filled = rows.map((row) => row.slice(0, row.findLastIndex((cell) => width(cell) > 0) + 1));
  const widths = columnWidths(filled);
  return filled.map((row) =>
    row.flatMap((cell, at): Line => (at === row.length - 1 ? cell : [...cell, " ".repeat((widths[at] ?? 0) - width(cell) + 2)])),
  );
};

/**
 * Rows for table() that fit `room` columns: the cells of the columns in
 * `shrink` cut, in that order, each to no less than its first row's (the
 * heading's) width.
 */
export const fit = (rows: readonly (readonly Line[])[], room: number, shrink: readonly number[]): typeof rows => {
  const widths = columnWidths(rows);
  const over = widths.reduce((sum, each) => sum + each, 0) + 2 * Math.max(0, widths.length - 1) - room;
  const cut = shrink.reduce<{ readonly widths: readonly number[]; readonly over: number }>(
    (so, at) => {
      const now = so.widths[at] ?? 0;
      const less = Math.min(Math.max(0, so.over), Math.max(0, now - width(rows[0]?.[at] ?? [])));
      return { widths: so.widths.with(at, now - less), over: so.over - less };
    },
    { widths, over },
  ).widths;
  return rows.map((row) => row.map((cell, at) => truncate(cell, cut[at] ?? width(cell))));
};

/** Paths by the root they are under, the longest first: the engine may live inside the fleet. */
export const shortener =
  (roots: readonly (readonly [string, string])[]) =>
  (text: string): string =>
    roots.toSorted(([a], [b]) => b.length - a.length).reduce((short, [path, name]) => short.replaceAll(path, name), text);
