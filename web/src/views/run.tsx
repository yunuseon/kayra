import { useEffect, useReducer, useState } from "preact/hooks";
import type { RunEvent } from "../../../cli/src/clients/api/contract.ts";
import { answerRun, cancelRun, stream } from "../api.ts";
import { Header, Lines, Pill, Spans, Waiting } from "../components/ui.tsx";
import { empty, outcome, reduce, type Outcome, type StepView } from "../run.ts";
import { styled } from "../sgr.ts";
import { duration } from "../time.ts";

const outcomeTone: Readonly<Record<Outcome, "active" | "ok" | "bad" | "warn">> = {
  running: "active",
  passed: "ok",
  failed: "bad",
  interrupted: "warn",
  declined: "warn",
};

const icon: Readonly<Record<StepView["state"], string>> = { waiting: "○", running: "", passed: "✓", failed: "✗", stopped: "■", skipped: "–" };

const Output = ({ step }: { readonly step: StepView }) => (
  <div class="output">
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
  </div>
);

const Step = ({ step, now }: { readonly step: StepView; readonly now: number }) => {
  const opened = step.state === "running" || step.state === "failed";
  const time = step.ms ?? (step.started === undefined ? undefined : now - step.started);
  const body = step.said.length === 0 ? null : <Output step={step} />;
  return (
    <details class={`step step-${step.state}`} open={opened}>
      <summary>
        <span class="step-icon">{step.state === "running" ? <span class="spinner" /> : icon[step.state]}</span>
        <span class="step-title">{step.listed.title}</span>
        <span class="step-kind">{step.listed.kind}</span>
        <span class="step-time">
          {step.why === undefined ? "" : `${step.why} · `}
          {time === undefined ? "" : duration(time)}
        </span>
      </summary>
      {body}
    </details>
  );
};

const Ask = ({ id, question }: { readonly id: string; readonly question: Extract<RunEvent, { readonly kind: "ask" }> }) => {
  const [typed, setTyped] = useState("");
  return (
    <form
      class="ask"
      onSubmit={(event) => {
        event.preventDefault();
        void answerRun(id, typed);
        setTyped("");
      }}
    >
      <Spans text={question.prompt} />
      <input type={question.secret ? "password" : "text"} autoComplete="off" value={typed} onInput={(event) => { setTyped(event.currentTarget.value); }} autoFocus spellcheck={false} />
      <button type="submit" class="button danger">
        Answer
      </button>
      <button type="button" class="button" onClick={() => void answerRun(id, "")}>
        Don't
      </button>
    </form>
  );
};

export const RunView = ({ id }: { readonly id: string }) => {
  const [view, dispatch] = useReducer((state: typeof empty, event: RunEvent) => reduce(state, event, Date.now()), empty);
  const [now, setNow] = useState(Date.now());
  useEffect(() => stream<RunEvent>(`/api/runs/${encodeURIComponent(id)}/events`, dispatch, () => undefined), [id]);
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
  const { invocation, steps, ended, asking } = view;
  if (invocation === undefined) return <Waiting what="Starting" />;
  const result = outcome(view);
  return (
    <>
      <Header
        title={<code class="command">{invocation.command}</code>}
        sub={`${invocation.about.join(" · ")} · ${String(steps.length)} steps`}
      >
        <Pill tone={outcomeTone[result]}>{result}</Pill>
        {running ? (
          <button class="button danger" onClick={() => void cancelRun(id)}>
            Stop
          </button>
        ) : null}
      </Header>
      {asking === undefined ? null : <Ask key={view.current} id={id} question={asking} />}
      <div class="timeline">
        {steps.map((step) => (
          <div key={step.listed.index}>
            {step.listed.opens === undefined ? null : <h3 class="part">{step.listed.opens}</h3>}
            <Step step={step} now={now} />
          </div>
        ))}
      </div>
      {ended === undefined ? null : (
        <footer class={`run-footer tone-border-${outcomeTone[result]}`}>
          <Lines lines={ended.footer} />
        </footer>
      )}
    </>
  );
};
