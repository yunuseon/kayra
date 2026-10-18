import type { ComponentChildren } from "preact";
import type { Line, Span, Text, Tone } from "../../../cli/src/clients/api/contract.ts";
import type { Failure } from "../api.ts";
import type { Cell } from "../reach.ts";

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

/** A status at a glance: a dot that breathes while its answer is still coming. */
export const Dot = ({ tone, label }: { readonly tone: Tone | "waiting"; readonly label?: string }) => (
  <span class={`dot dot-${tone}`} title={label} aria-label={label} role={label === undefined ? undefined : "img"} />
);

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
    <strong>kayra ui answered {failure.status}</strong>
    <pre>{failure.message}</pre>
  </div>
);

export const Waiting = ({ what }: { readonly what: string }) => (
  <div class="waiting">
    <span class="spinner" aria-hidden="true" /> {what}
  </div>
);

export const Header = ({ title, sub, children }: { readonly title: ComponentChildren; readonly sub?: ComponentChildren; readonly children?: ComponentChildren }) => (
  <header class="page-header">
    <div>
      <h1>{title}</h1>
      {sub === undefined ? null : <div class="sub">{sub}</div>}
    </div>
    {children === undefined ? null : <div class="actions">{children}</div>}
  </header>
);
