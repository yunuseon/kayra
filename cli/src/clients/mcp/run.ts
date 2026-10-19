import { stripVTControlCharacters } from "node:util";
import type { Heading, Event } from "../../core/interpreter/events.ts";
import { reporting } from "../../core/interpreter/events.ts";
import type { Io } from "../../core/interpreter/io.ts";
import { interpret } from "../../core/interpreter/loop.ts";
import type { Plan } from "../../core/plan/model.ts";
import { duration } from "../../core/text/time.ts";
import { flat, type Text } from "../../core/text/spans.ts";
import { typed } from "../../typed.ts";

/** What a run told along the way: the interpreter's events, a step's output, what kayra said around it. */
type Told = Event | { readonly kind: "output"; readonly chunk: string } | { readonly kind: "said"; readonly text: Text };

/** A plan's confirmations, in order: what the operator was asked to type before it ran. */
export const confirmations = (plan: Plan) =>
  Object.freeze(plan.flatMap((step, index) => (step.kind === "confirm" ? [{ key: `confirm-${String(index)}`, warning: step.warning, expect: step.expect } as const] : [])));

export type Confirmation = ReturnType<typeof confirmations>[number];

/** How a run is shown to an agent, and when it is told a step began. */
export type Watching = {
  readonly about: Heading;
  readonly short: (text: string) => string;
  /** Its output is its answer: nothing drawn around it. */
  readonly bare: boolean;
  /** What the operator typed for each confirmation, in order; undefined for none. */
  readonly typed: readonly (string | undefined)[];
  readonly signal: NonNullable<Io["signal"]>;
  readonly began: (index: number, total: number, title: string) => void;
};

const secretNote = (question: Text, server: string | undefined) => [
  `kayra mcp passes no password, and this step needed one: ${flat(question).trim().replace(/^\?\s*/, "").replace(/:$/, "")}.`,
  `Name a vault_password_file in ${server === undefined ? "the server's" : `servers/${server}/`}server.yml, have sudo's cached (sudo -v), or run the command in a terminal.`,
].join(" ");

/** The run as text: the heading, each step with its output and how it went, the footer. */
const report = (told: readonly Told[], about: Heading, bare: boolean) => {
  const titles = told.flatMap((event) => (event.kind === "plan" ? event.steps.map((step) => step.title) : []));
  const lines = told.flatMap((event) => {
    switch (event.kind) {
      case "plan":
        return bare ? [] : [`${about.command} · ${about.about.join(" · ")}`];
      case "started":
        return bare ? [] : [`▸ ${titles[event.index] ?? ""}`];
      case "output":
        return [stripVTControlCharacters(event.chunk).replace(/\n$/, "")];
      case "said":
        return [flat(event.text)];
      case "done":
        return bare || (!event.failed && !event.stopped)
          ? []
          : [`${event.failed ? "✗" : "■"} ${titles[event.index] ?? ""}${event.why === undefined ? "" : ` · ${event.why}`} · ${duration(event.ms)}`];
      case "ended":
        return bare && event.failures === 0 && event.stop === undefined ? [] : event.footer.map(flat);
    }
  });
  return lines.filter((line) => line !== "").join("\n");
};

/** Runs a plan with no terminal: every step's output piped and collected, questions answered from what was asked up front. */
export const run = async (plan: Plan, watching: Watching) => {
  // eslint-disable-next-line functional/prefer-immutable-types -- the run's events, collected as they come
  const told: Told[] = [];
  // eslint-disable-next-line functional/immutable-data -- see above
  const tell = (event: Told) => { told.push(event); };
  const asked = { confirmations: 0 };
  const total = plan.length;
  const io = typed<Io>({
    out: (text) => { tell({ kind: "said", text }); },
    err: (text) => { tell({ kind: "said", text }); },
    ask: (question) => {
      if (question.kind === "secret") {
        tell({ kind: "said", text: secretNote(question.text, watching.about.server) });
        return Promise.resolve(undefined);
      }
      const answer = watching.typed[asked.confirmations];
      // eslint-disable-next-line functional/immutable-data -- see above
      asked.confirmations += 1;
      return Promise.resolve(answer);
    },
    output: (chunk) => { tell({ kind: "output", chunk }); },
    signal: watching.signal,
  });
  const progress = reporting((event) => {
    tell(event);
    if (event.kind === "started") watching.began(event.index, total, told.flatMap((each) => (each.kind === "plan" ? [each.steps[event.index]?.title ?? ""] : []))[0] ?? "");
  }, watching.about, watching.short);
  await interpret(plan, io, progress);
  // Stopped is not passed here, even when the operator declined: for an agent, what it asked for did not happen.
  const passed = told.some((event) => event.kind === "ended" && event.failures === 0 && event.stop === undefined);
  return { passed, text: report(told, watching.about, watching.bare) } as const;
};
