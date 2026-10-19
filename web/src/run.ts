import type { Invocation, Line, Listed, RunEvent, Stop, Text } from "../../cli/src/clients/wire/contract.gen.ts";
import { typed } from "./typed.ts";

export type StepState = "waiting" | "running" | "passed" | "failed" | "stopped" | "skipped";

/** What a step printed, in order: a program's output, or kayra's own words. */
export type Said = { readonly kind: "output"; readonly stream: "stdout" | "stderr"; readonly chunk: string } | { readonly kind: "said"; readonly stream: "out" | "err"; readonly text: Text };

export type StepView = {
  readonly listed: Listed;
  readonly state: StepState;
  readonly started?: number;
  readonly ms?: number;
  readonly why?: string;
  readonly said: readonly Said[];
};

export type Ended = { readonly failures: number; readonly stop?: { readonly index: number; readonly why: Stop }; readonly ms: number; readonly footer: readonly Line[] };

/** A run as its viewer shows it, folded from its events. */
export type RunView = {
  readonly invocation: Invocation | undefined;
  readonly steps: readonly StepView[];
  /** The step that started last: what is printed belongs to it, also what kayra says right after it. */
  readonly current: number | undefined;
  readonly asking: Extract<RunEvent, { readonly kind: "ask" }> | undefined;
  readonly ended: Ended | undefined;
};

export const empty: RunView = { invocation: undefined, steps: [], current: undefined, asking: undefined, ended: undefined };

const at = (view: RunView, index: number | undefined, change: (step: StepView) => StepView) =>
  index === undefined ? view : typed<RunView>({ ...view, steps: view.steps.map((step, each) => (each === index ? change(step) : step)) });

const said = (view: RunView, line: Said) => at(view, view.current, (step) => ({ ...step, said: [...step.said, line] } as const));

/** One event onto the view; `now` stamps when a step started, for its running time. */
export const reduce = (view: RunView, event: RunEvent, now: number) => {
  switch (event.kind) {
    case "plan":
      return typed<RunView>({ ...view, invocation: event.invocation, steps: event.steps.map((listed) => ({ listed, state: "waiting", said: [] } as const)) });
    case "started":
      return at({ ...view, current: event.index }, event.index, (step) => ({ ...step, state: "running", started: now } as const));
    case "done":
      return at(view, event.index, (step) => ({
        ...step,
        state: event.failed ? "failed" : event.stopped ? "stopped" : "passed",
        ms: event.ms,
        ...(event.why === undefined ? {} : { why: event.why }),
      } as const));
    case "ended": {
      const ended: Ended = { failures: event.failures, ms: event.ms, footer: event.footer, ...(event.stop === undefined ? {} : { stop: event.stop }) };
      return typed<RunView>({
        ...view,
        asking: undefined,
        ended,
        // The step a run was interrupted at was stopped, whatever its program said on the way out; those after it never ran.
        steps: view.steps.map((step, index) =>
          step.state === "running" || (event.stop?.why === "interrupted" && event.stop.index === index)
            ? { ...step, state: "stopped" }
            : step.state === "waiting"
              ? { ...step, state: "skipped" }
              : step,
        ),
      });
    }
    case "output":
      return said(view, { kind: "output", stream: event.stream, chunk: event.chunk });
    case "said":
      return said(view, { kind: "said", stream: event.stream, text: event.text });
    case "ask":
      return typed<RunView>({ ...view, asking: event });
    case "answered":
      return typed<RunView>({ ...view, asking: undefined });
  }
};

export type Outcome = "running" | "passed" | "failed" | "interrupted" | "declined";

export const outcome = (view: RunView) => {
  const { ended } = view;
  if (ended === undefined) return typed<Outcome>("running");
  if (ended.stop?.why === "interrupted") return typed<Outcome>("interrupted");
  if (ended.stop?.why === "declined") return typed<Outcome>("declined");
  return ended.failures === 0 ? typed<Outcome>("passed") : typed<Outcome>("failed");
};
