import { characters, width, type Line, type Span } from "./line.ts";

/** 0.4s, 12s, 2m03s, 1h04m: never more precise than it is worth reading. */
export const duration = (ms: number): string => {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 10) return `${(Math.floor(seconds * 10) / 10).toFixed(1)}s`;
  if (seconds < 60) return `${String(Math.floor(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${String(minutes)}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
  return `${String(Math.floor(minutes / 60))}h${String(minutes % 60).padStart(2, "0")}m`;
};

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
      const piece: Span = typeof span === "string" ? kept : { tone: span.tone, text: kept };
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
