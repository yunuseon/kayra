export type Choice = { readonly label: string; readonly hint: string };
import { typed } from "./typed.ts";

/**
 * How well `query` matches `label`: every letter in order, the closer
 * together and the nearer the start the better; undefined if it does not.
 */
export const score = (label: string, query: string) => {
  const wanted = query.toLowerCase().replace(/\s+/g, "");
  if (wanted === "") return typed<number | undefined>(0);
  const text = label.toLowerCase();
  const found = Array.from(wanted).reduce<{ readonly at: number; readonly gaps: number; readonly first: number } | undefined>((so, letter) => {
    if (so === undefined) return undefined;
    const at = text.indexOf(letter, so.at);
    return at === -1 ? undefined : { at: at + 1, gaps: so.gaps + (so.first === -1 ? 0 : at - so.at), first: so.first === -1 ? at : so.first } as const;
  }, { at: 0, gaps: 0, first: -1 });
  return found === undefined ? undefined : found.gaps * 2 + found.first + (text.startsWith(wanted) ? -10 : 0);
};

/** The choices that match, the best first; with no query, as given. */
export const ranked = <T extends Choice>(choices: readonly T[], query: string) =>
  Object.freeze(choices
    .flatMap((choice) => {
      const scored = score(`${choice.label} ${choice.hint}`, query);
      return scored === undefined ? Object.freeze([]) : Object.freeze([{ choice, scored } as const]);
    })
    .toSorted((a, b) => a.scored - b.scored)
    .map((each) => each.choice));
