import { styleText } from "node:util";
import { spans, type Text, type Tone } from "../../core/present/line.ts";
import { escapes } from "./terminal.ts";

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

export const paint = (text: Text, colors: boolean, links = false): string =>
  spans(text)
    .map((span) => {
      if (typeof span === "string") return span;
      const { tone, href } = span;
      const styled =
        colors && tone !== undefined
          ? looks[tone].reduce((so, format) => styleText(format, so, { validateStream: false }), span.text)
          : span.text;
      return links && href !== undefined ? escapes.link(styled, href) : styled;
    })
    .join("");
