import type { ComponentChildren } from "preact";
import type { Line, OperationInfo, Span, Text, Tone } from "../../../cli/src/clients/wire/contract.gen.ts";
import type { Failure } from "../api.ts";
import { bracket, glyph, type Cell } from "../reach.ts";

const spanOf = (span: Span, key: number) => {
  if (typeof span === "string") return span;
  const tone = span.tone === undefined ? undefined : `tone-${span.tone}`;
  return span.href === undefined ? (
    <span key={key} class={tone}>
      {span.text}
    </span>
  ) : (
    <a key={key} class={tone} href={span.href} target="_blank" rel="noreferrer">
      {span.text}
    </a>
  );
};

/** kayra's own words, in its tones: the same spans the terminal paints. */
export const Spans = ({ text }: { readonly text: Text }) => <>{(typeof text === "string" ? [text] : text).map(spanOf)}</>;

export const Lines = ({ lines }: { readonly lines: readonly Line[] }) => (
  <div class="lines">
    {lines.map((line, index) => (
      <div key={index}>
        <Spans text={line} />
      </div>
    ))}
  </div>
);

/** A status at a glance: its glyph, which breathes while its answer is still coming. */
export const Dot = ({ tone, label }: { readonly tone: Tone | "waiting"; readonly label?: string }) => (
  <span class={`dot dot-${tone}`} title={label} aria-label={label} role={label === undefined ? undefined : "img"} aria-hidden={label === undefined ? true : undefined}>
    {glyph[tone]}
  </span>
);

/** A state as a boot log prints it: `[  OK  ]`. */
export const Tag = ({ word, tone }: { readonly word: string; readonly tone: Tone | "waiting" }) => (
  <span class={`tag tone-${tone}${tone === "waiting" || tone === "active" ? " pulse" : ""}`}>{bracket(word)}</span>
);

const effects: Readonly<Record<OperationInfo["effect"], string>> = { reads: "read only", changes: "changes", destroys: "destroys" };

/** What an operation does to the world, as a badge: the same words in every list. */
export const Effect = ({ effect }: { readonly effect: OperationInfo["effect"] }) => <span class={`badge badge-${effect}`}>{effects[effect]}</span>;

export const Pill = ({ children, tone }: { readonly children: ComponentChildren; readonly tone?: Tone }) => (
  <span class={`pill${tone === undefined ? "" : ` pill-${tone}`}`}>{children}</span>
);

export const Fact = ({ label, cell }: { readonly label: string; readonly cell: Cell | undefined }) =>
  cell === undefined ? null : (
    <div class="fact">
      <dt>{label}</dt>
      <dd title={cell.title}>
        <Dot tone={cell.tone} />
        <span class={cell.tone === "waiting" ? "tone-muted" : `tone-${cell.tone}`}>{cell.text}</span>
      </dd>
    </div>
  );

export const Problem = ({ failure }: { readonly failure: Failure }) => (
  <div class="problem" role="alert">
    <strong>{failure.status === 0 ? "Connection problem" : `kayra answered ${String(failure.status)}`}</strong>
    <pre>{failure.message}</pre>
  </div>
);

export const Waiting = ({ what }: { readonly what: string }) => (
  <div class="waiting">
    <span class="spinner" aria-hidden="true" /> {what}
  </div>
);

export const Header = ({
  kicker,
  title,
  tag,
  sub,
  children,
}: {
  readonly kicker?: ComponentChildren;
  readonly title: ComponentChildren;
  readonly tag?: ComponentChildren;
  readonly sub?: ComponentChildren;
  readonly children?: ComponentChildren;
}) => (
  <header class="page-header">
    <div class="page-title">
      {kicker === undefined ? null : <div class="kicker">{kicker}</div>}
      <div class="title-row">
        <h1>{title}</h1>
        {tag}
      </div>
      {sub === undefined ? null : <div class="sub">{sub}</div>}
    </div>
    {children === undefined ? null : <div class="actions">{children}</div>}
  </header>
);

/** A part of a page: its name in small capitals, a dashed rule, then what it holds. */
export const Section = ({
  title,
  meta,
  aside,
  children,
  class: className,
}: {
  readonly title: string;
  readonly meta?: ComponentChildren;
  readonly aside?: ComponentChildren;
  readonly children: ComponentChildren;
  readonly class?: string;
}) => (
  <section class={className === undefined ? "section" : `section ${className}`} aria-label={title}>
    <div class="section-head">
      <h2>{title}</h2>
      <span class="rule" aria-hidden="true" />
      {meta === undefined ? null : <span class="meta">{meta}</span>}
      {aside}
    </div>
    {children}
  </section>
);
