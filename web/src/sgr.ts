/** A piece of a program's output with the look its colour codes gave it. */
export type Styled = { readonly text: string; readonly classes: string };
import { typed } from "./typed.ts";

type Look = { readonly fg: string | undefined; readonly bold: boolean; readonly dim: boolean };

const plain: Look = { fg: undefined, bold: false, dim: false };

const colours = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

/** One SGR parameter list (`0;32`, `1`, `38;5;208`) applied to the look so far. */
const apply = (look: Look, params: string) => {
  const codes = params === "" ? [0] : params.split(";").map(Number);
  const step = (so: Look, rest: readonly number[]) => {
    const [code, ...more] = rest;
    if (code === undefined) return so;
    // 256 colours and true colour: their arguments are no codes of their own.
    if (code === 38 || code === 48) return step(so, more[0] === 5 ? more.slice(2) : more[0] === 2 ? more.slice(4) : more);
    if (code === 0) return step(plain, more);
    if (code === 1) return step({ ...so, bold: true }, more);
    if (code === 2) return step({ ...so, dim: true }, more);
    if (code === 22) return step({ ...so, bold: false, dim: false }, more);
    if (code === 39) return step({ ...so, fg: undefined }, more);
    if (code >= 30 && code <= 37) return step({ ...so, fg: colours[code - 30] }, more);
    if (code >= 90 && code <= 97) return step({ ...so, fg: `bright-${colours[code - 90] ?? "white"}` }, more);
    return step(so, more);
  };
  return step(look, codes);
};

const classesOf = (look: Look) =>
  [look.fg === undefined ? "" : `sgr-${look.fg}`, look.bold ? "sgr-bold" : "", look.dim ? "sgr-dim" : ""].filter((each) => each !== "").join(" ");

// SGR sequences are kept; every other escape (cursor moves, line clears, titles) is dropped.
// eslint-disable-next-line no-control-regex -- terminal escapes are control characters: matching them is the point
const escapes = /\u001b\[([0-9;]*)m|\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Output with colour codes as styled pieces; text that is not a code stays as it came. */
export const styled = (text: string) => {
  const pieces = [...text.matchAll(escapes)].reduce<{ readonly out: readonly Styled[]; readonly look: Look; readonly at: number }>(
    (so, match) => {
      const before = text.slice(so.at, match.index);
      const out = before === "" ? so.out : [...so.out, { text: before, classes: classesOf(so.look) }];
      const sgr = match[1];
      return { out, look: sgr === undefined ? so.look : apply(so.look, sgr), at: match.index + match[0].length } as const;
    },
    { out: [], look: plain, at: 0 },
  );
  const rest = text.slice(pieces.at);
  return rest === "" ? pieces.out : typed<readonly Styled[]>([...pieces.out, { text: rest, classes: classesOf(pieces.look) }]);
};
