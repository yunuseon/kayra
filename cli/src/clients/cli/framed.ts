import { titleOf } from "../../core/plan/describe.ts";
import { accent, active, bad, muted, ok, strong, type Text } from "../../core/text/spans.ts";
import { footer, steps, type Heading } from "../../core/interpreter/events.ts";
import type { Progress } from "../../core/interpreter/progress.ts";
import { duration } from "../../core/text/time.ts";
import { spread, truncate } from "./text.ts";
import { paint } from "./paint.ts";
import { escapes, spinner, type Screen } from "./terminal.ts";

/** A run of this long earns a notification when it ends: the operator has looked away. */
const worthNotifying = 30_000;

/** Frames on stderr: a heading, each step as it runs and how it went, a footer; on a terminal also spinners, the window title, a notification. */
export const framed = (screen: Screen, write: (raw: string) => void, invocation: Heading): Progress => {
  const columns = Math.min(screen.columns, 80);
  const say = (text: Text): void => {
    write(`${paint(text, screen.colors)}\n`);
  };
  const tell = (raw: string, when: boolean): void => {
    if (when) write(raw);
  };
  return {
    plan: async (plan, work) => {
      const started = performance.now();
      tell(escapes.pushTitle + escapes.title(invocation.command), screen.title);
      say([strong(invocation.command), muted([...invocation.about, steps(plan)].map((each) => ` · ${each}`).join(""))]);
      say("");
      const ended = await work();
      const ms = performance.now() - started;
      say("");
      footer(invocation, plan, ended, ms).forEach(say);
      tell(escapes.popTitle, screen.title);
      tell(escapes.progressDone, screen.progressBar);
      const failed = ended.failures > 0 || ended.stop?.why === "failed";
      tell(escapes.notify(`${invocation.command} ${failed ? "failed" : "is done"} after ${duration(ms)}`), screen.notifications && ms >= worthNotifying);
      return ended;
    },
    step: async (step, at, work) => {
      if (step.kind === "confirm" || step.kind === "note") return work();
      if (at.opens !== undefined) {
        if (at.index > 0) say("");
        say([accent(at.opens)]);
      }
      const title = titleOf(step);
      const counter = `${String(at.index + 1)}/${String(at.total)}`;
      tell(escapes.title(`${invocation.command} · ${counter} ${title}`), screen.title);
      tell(escapes.progress((at.index / at.total) * 100), screen.progressBar);
      const shown = step.kind === "run" && step.stdout === "show";
      if (shown) say(spread(["  ", active("◆"), " ", strong(title)], [muted(counter)], columns));
      const stop =
        !shown && screen.live
          ? spinner(write, (frame, ms) =>
              paint(spread(truncate(["  ", active(frame), " ", title], columns - 8), [muted(duration(ms))], columns), screen.colors),
            )
          : () => undefined;
      const started = performance.now();
      const done = await work();
      stop();
      // A diagnosis reports itself on stdout: that line is doctor's output.
      if (step.kind === "check" && step.onFailure === "continue") return done;
      const took = duration(performance.now() - started);
      say(
        spread(
          ["  ", done.failed ? bad("✗") : ok("✓"), " ", title],
          [muted(done.why === undefined ? took : `${done.why} · ${took}`)],
          columns,
        ),
      );
      return done;
    },
  };
};
