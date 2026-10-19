/** What a piece of text means, not how it looks: each client gives it a look (a terminal colour, a CSS class), or none. */
export const tones = ["ok", "bad", "warn", "active", "muted", "strong", "accent"] as const;
export type Tone = (typeof tones)[number];

/** `href`: where the text leads, on a terminal that makes links of it. */
export type Span = string | { readonly tone?: Tone; readonly text: string; readonly href?: string };
/** One line of output, as spans of meaning. */
export type Line = readonly Span[];
/** What kayra writes: a plain string, or a line of spans. */
export type Text = string | Line;

const toned =
  (tone: Tone) =>
  (text: string): Span => ({ tone, text });

export const ok = toned("ok");
export const bad = toned("bad");
export const warn = toned("warn");
export const active = toned("active");
export const muted = toned("muted");
export const strong = toned("strong");
export const accent = toned("accent");

export const link = (text: string, href: string, tone?: Tone): Span => ({ text, href, ...(tone === undefined ? {} : { tone }) });

export const spans = (text: Text): Line => (typeof text === "string" ? [text] : text);

const textOf = (span: Span): string => (typeof span === "string" ? span : span.text);

export const flat = (text: Text): string => spans(text).map(textOf).join("");

const graphemes = new Intl.Segmenter();

/** A string's characters as a reader counts them. */
export const characters = (text: string): readonly string[] => Array.from(graphemes.segment(text), (each) => each.segment);

/** Columns it takes: one per character, which holds for everything kayra writes itself. */
export const width = (text: Text): number => characters(flat(text)).length;

/** What to do about it, under what it is about: an arrow, then the advice. */
export const pointing = (indent: string, ...said: readonly Span[]): Line => [indent, active("→"), " ", ...said];
