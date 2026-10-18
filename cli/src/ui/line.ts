import { styleText } from "node:util";

/** What a piece of text means, not how it looks: the stream it goes to picks colors, or none. */
export type Tone = "ok" | "bad" | "warn" | "active" | "muted" | "strong" | "accent";

export type Span = string | { readonly tone: Tone; readonly text: string };
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

type Format = Exclude<Parameters<typeof styleText>[0], readonly unknown[]>;

const looks: Readonly<Record<Tone, readonly Format[]>> = {
  ok: ["green"],
  bad: ["red"],
  warn: ["yellow"],
  active: ["cyan"],
  muted: ["dim"],
  strong: ["bold"],
  accent: ["magenta", "bold"],
};

const spans = (text: Text): Line => (typeof text === "string" ? [text] : text);

const textOf = (span: Span): string => (typeof span === "string" ? span : span.text);

export const flat = (text: Text): string => spans(text).map(textOf).join("");

const graphemes = new Intl.Segmenter();

/** A string's characters as a reader counts them. */
export const characters = (text: string): readonly string[] => Array.from(graphemes.segment(text), (each) => each.segment);

/** Columns it takes: one per character, which holds for everything kayra writes itself. */
export const width = (text: Text): number => characters(flat(text)).length;

export const paint = (text: Text, colors: boolean): string =>
  spans(text)
    .map((span) =>
      typeof span === "string" || !colors
        ? textOf(span)
        : looks[span.tone].reduce((styled, format) => styleText(format, styled, { validateStream: false }), span.text),
    )
    .join("");
