import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import type { RunEvent } from "../../../cli/src/clients/wire/contract.gen.ts";
import { cancelRun, stream, type Failure } from "../api.ts";
import { Question } from "../components/question.tsx";
import { Header, Lines, Problem, Section, Spans, Tag, Waiting } from "../components/ui.tsx";
import { empty, outcome, reduce, type Outcome, type StepView } from "../run.ts";
import { styled } from "../sgr.ts";
import { duration } from "../time.ts";

const outcomeTag: Readonly<Record<Outcome, { readonly word: string; readonly tone: "active" | "ok" | "bad" | "warn" }>> = {
  running: { word: "RUN", tone: "active" },
  passed: { word: "OK", tone: "ok" },
  failed: { word: "FAILED", tone: "bad" },
  interrupted: { word: "STOPPED", tone: "warn" },
  declined: { word: "DECLINED", tone: "warn" },
};

const icon: Readonly<Record<StepView["state"], { readonly glyph: string; readonly tone: string }>> = {
  waiting: { glyph: "○", tone: "tone-muted" },
  running: { glyph: "◐", tone: "tone-active pulse" },
  passed: { glyph: "✓", tone: "tone-ok" },
  failed: { glyph: "✕", tone: "tone-bad" },
  stopped: { glyph: "■", tone: "tone-warn" },
  skipped: { glyph: "–", tone: "tone-muted" },
};

const Output = ({ step }: { readonly step: StepView }) => (
  <>
    {step.said.map((line, index) =>
      line.kind === "output" ? (
        <span key={index} class={line.stream === "stderr" ? "stderr" : undefined}>
          {styled(line.chunk).map((piece, at) => (
            <span key={at} class={piece.classes === "" ? undefined : piece.classes}>
              {piece.text}
            </span>
          ))}
        </span>
      ) : (
        <div key={index} class={line.stream === "err" ? "said said-err" : "said"}>
          <Spans text={line.text} />
        </div>
      ),
    )}
  </>
);

const elapsed = (step: StepView, now: number) => step.ms ?? (step.started === undefined ? undefined : now - step.started);

const Steps = ({ steps, now, picked, pick }: { readonly steps: readonly StepView[]; readonly now: number; readonly picked: number | undefined; readonly pick: (index: number | undefined) => void }) => (
  <ol class="steps panel">
    {steps.map((step) => {
      const time = elapsed(step, now);
      const index = step.listed.index;
      const here = picked === index;
      return (
        <li key={index}>
          {step.listed.opens === undefined ? null : <div class="part">{step.listed.opens}</div>}
          <button
            type="button"
            aria-pressed={here}
            class={`step-button step-${step.state}${here ? " on" : step.state === "running" || step.state === "failed" ? ` ${step.state}` : ""}`}
            onClick={() => {
              pick(here ? undefined : index);
            }}
          >
            <span class={icon[step.state].tone} aria-label={step.state}>
              {icon[step.state].glyph}
            </span>
            <span>
              <span class="step-title">{step.listed.title}</span>
              <span class="step-kind">{step.why === undefined ? step.listed.kind : `${step.listed.kind} · ${step.why}`}</span>
            </span>
            <span class="step-time">{time === undefined ? step.state : duration(time)}</span>
          </button>
        </li>
      );
    })}
  </ol>
);

export const RunView = ({ id }: { readonly id: string }) => {
  const [view, dispatch] = useReducer((state: typeof empty, event: RunEvent) => reduce(state, event, Date.now()), empty);
  const [now, setNow] = useState(Date.now());
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const [picked, setPicked] = useState<number | undefined>(undefined);
  const [following, setFollowing] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => stream<RunEvent>(`/api/runs/${encodeURIComponent(id)}/events`, dispatch, () => undefined, undefined, setFailure), [id]);
  const running = outcome(view) === "running";
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 250);
    return () => {
      clearInterval(timer);
    };
  }, [running]);
  useEffect(() => {
    if (following) box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [view, following, picked]);
  const { invocation, steps, ended, asking } = view;
  if (invocation === undefined) return failure === undefined ? <Waiting what="Starting" /> : <Problem failure={failure} />;
  const result = outcome(view);
  const tag = outcomeTag[result];
  const begun = steps.flatMap((step) => (step.started === undefined ? [] : [step.started]));
  const took = ended?.ms ?? (begun.length === 0 ? 0 : now - Math.min(...begun));
  const passed = steps.filter((step) => step.state === "passed").length;
  const stop = ended?.stop;
  const stoppedAt = stop === undefined ? undefined : steps.find((step) => step.listed.index === stop.index);
  const firstFailed = steps.find((step) => step.state === "failed");
  const shown = steps.filter((step) => (picked === undefined || step.listed.index === picked) && step.said.length > 0);
  return (
    <>
      <Header kicker={`run · ${id}`} title={<code>{invocation.command}</code>} tag={<Tag word={tag.word} tone={tag.tone} />} sub={[...invocation.about, `${String(steps.length)} steps`].join(" · ")}>
        <div class="elapsed">
          <strong>{duration(took)}</strong>
          <span>
            {passed} of {steps.length} steps passed
          </span>
        </div>
        {running ? (
          <button type="button" class="button danger" onClick={() => { void cancelRun(id).then((answer) => { if (!answer.ok) setFailure(answer.failure); }); }}>
            stop
          </button>
        ) : null}
      </Header>

      <div class="progress" role="img" aria-label={`${String(passed)} of ${String(steps.length)} steps passed`}>
        {steps.map((step) => (
          <span key={step.listed.index} class={step.state} />
        ))}
      </div>

      {failure === undefined ? null : <Problem failure={failure} />}
      {stop === undefined || stoppedAt === undefined ? null : (
        <div class={`banner ${stop.why === "failed" ? "banner-bad" : "banner-warn"}`} role="alert">
          <span class={stop.why === "failed" ? "tone-bad" : "tone-warn"} aria-hidden="true">
            {stop.why === "failed" ? "✕" : "■"}
          </span>
          <div class="prose">
            <strong>
              {stop.why === "failed" ? "Stopped at" : stop.why === "declined" ? "Declined at" : "Interrupted at"} {stoppedAt.listed.title}.
            </strong>{" "}
            {stoppedAt.why ?? ""} Nothing after it ran.
          </div>
          <button type="button" class="button small" onClick={() => { setPicked(stop.index); }}>
            show it
          </button>
        </div>
      )}
      {stop !== undefined || ended === undefined || ended.failures === 0 || firstFailed === undefined ? null : (
        <div class="banner banner-bad" role="alert">
          <span class="tone-bad" aria-hidden="true">
            ✕
          </span>
          <div class="prose">
            <strong>
              {ended.failures} {ended.failures === 1 ? "step" : "steps"} failed,
            </strong>{" "}
            the first at {firstFailed.listed.title}. The rest ran; the footer says what to do.
          </div>
          <button type="button" class="button small" onClick={() => { setPicked(firstFailed.listed.index); }}>
            show it
          </button>
        </div>
      )}
      {asking === undefined ? null : <Question key={JSON.stringify(asking)} id={id} question={asking} />}

      <div class="split">
        <div class="side">
          <Section title="steps" meta="from the plan">
            <Steps steps={steps} now={now} picked={picked} pick={setPicked} />
          </Section>
        </div>
        <div class="wide">
          <Section
            title="log"
            aside={
              <>
                {picked === undefined ? null : (
                  <button type="button" class="button small" onClick={() => { setPicked(undefined); }} aria-label="Show every step">
                    {steps.find((step) => step.listed.index === picked)?.listed.title ?? ""} ×
                  </button>
                )}
                <button type="button" class="button small" aria-pressed={following} onClick={() => { setFollowing(!following); }}>
                  <span class={following && running ? "tone-active pulse" : "tone-muted"} aria-hidden="true">●</span>
                  {following ? "following" : "follow"}
                </button>
              </>
            }
          >
            <div class="terminal-panel">
              <div
                ref={box}
                class="terminal-scrollbox"
                onWheel={(event) => {
                  if (event.deltaY < 0) setFollowing(false);
                }}
              >
                {shown.length === 0 ? (
                  <span class="tone-muted">{running ? "Waiting for output…" : "Nothing was printed here."}</span>
                ) : (
                  shown.map((step) => (
                    <div key={step.listed.index}>
                      <div class="log-step">
                        ── {step.listed.index + 1} · {step.listed.title} ──
                      </div>
                      <Output step={step} />
                    </div>
                  ))
                )}
                {running && following ? <span class="cursor" aria-hidden="true">▌</span> : null}
              </div>
              {ended === undefined ? null : (
                <footer class="run-footer">
                  <Lines lines={ended.footer} />
                </footer>
              )}
            </div>
          </Section>
        </div>
      </div>
    </>
  );
};
