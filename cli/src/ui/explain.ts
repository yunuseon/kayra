import { commandOf, kindOf, titleOf, type Plan, type Step } from "../plan.ts";
import { accent, active, bad, muted, strong, warn, type Line, type Span } from "./line.ts";
import { position, steps as count, type Invocation } from "./progress.ts";
import { wrap } from "./text.ts";
import { drawnAs } from "./views.ts";

const kinds: Readonly<Record<string, (text: string) => Span>> = { guard: warn, check: active, run: active, confirm: bad, note: muted };

const tag = (step: Step): Span => {
  const kind = kindOf(step);
  return (kinds[kind] ?? muted)(kind.padEnd(7));
};

/**
 * --dry-run on a terminal: each step numbered, with its title and, below it, the
 * command it runs. `short` names paths by their root (<kayra>, <fleet>, ~), so a
 * command fits on a line or two; render() is the plain, copyable form.
 */
export const explain = (
  invocation: Invocation,
  plan: Plan,
  short: (text: string) => string,
  columns: number,
): readonly Line[] => {
  const digits = String(plan.length).length;
  const indent = " ".repeat(digits + 13);
  const steps = plan.flatMap((step, index): readonly Line[] => {
    const { opens } = position(plan, index);
    const command = commandOf(step);
    return [
      ...(opens === undefined ? [] : index === 0 ? [[accent(opens)]] : [[], [accent(opens)]]),
      ["  ", muted(String(index + 1).padStart(digits)), "  ", tag(step), "  ", strong(titleOf(step))],
      ...(step.kind === "confirm" ? [[indent, muted(`asks for '${step.expect}' to be typed, or stops`)]] : []),
      ...(command === undefined
        ? []
        : wrap(short(command).split(" "), Math.max(40, Math.min(columns, 120) - indent.length - 2)).map(
            (line, at): Line => [indent, muted(at === 0 ? line : `  ${line}`)],
          )),
      ...(step.kind === "run" && typeof step.stdout === "object" ? [[indent, muted(`→ ${drawnAs(step.stdout)}`)]] : []),
    ];
  });
  return [
    [strong(invocation.command), muted([...invocation.about, count(plan), "dry run: nothing runs"].map((each) => ` · ${each}`).join(""))],
    [],
    ...steps,
  ];
};
