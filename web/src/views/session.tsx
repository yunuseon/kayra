import { useEffect, useRef, useState } from "preact/hooks";
import type { Invocation, Listed, RunEvent, RunState } from "../../../cli/src/clients/api/contract.gen.ts";
import { closeSession, sessionInput, stream, type Failure } from "../api.ts";
import { Question } from "../components/question.tsx";
import { Header, Pill, Problem } from "../components/ui.tsx";
import { orderedInput, terminalOutput } from "../session.ts";
import "@xterm/xterm/css/xterm.css";

export const SessionView = ({ id }: { readonly id: string }) => {
  const host = useRef<HTMLDivElement>(null);
  const [invocation, setInvocation] = useState<Invocation | undefined>(undefined);
  const [question, setQuestion] = useState<Extract<RunEvent, { readonly kind: "ask" }> | undefined>(undefined);
  const [state, setState] = useState<RunState>("running");
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    const active = { current: true };
    const dispose: { current: () => void } = { current: () => undefined };
    const setup = async () => {
      const { Terminal } = await import("@xterm/xterm");
      if (!active.current || host.current === null) return;
      const terminal = new Terminal({
        cols: 120,
        rows: 32,
        fontSize: 13,
        cursorBlink: true,
        disableStdin: true,
        theme: { background: "#0a0a0c", foreground: "#e4e4e8" },
      });
      terminal.open(host.current);
      terminal.focus();
      // eslint-disable-next-line functional/prefer-immutable-types -- retain the plan while replaying this session's events
      const steps: { current: readonly Listed[] } = { current: [] };
      const ended = { current: false };
      const ready = { current: false };
      const refused = { current: false };
      const disable = (value: boolean) => {
        ready.current = !value;
        // eslint-disable-next-line functional/immutable-data -- xterm controls terminal input through its public options
        terminal.options.disableStdin = value;
      };
      const fail = (failure: Failure) => {
        refused.current = true;
        disable(true);
        setFailure(failure);
      };
      const send = orderedInput((text) => sessionInput(id, text), fail);
      const input = terminal.onData((text) => {
        if (ready.current) send(text);
      });
      const stop = stream<RunEvent>(
        `/api/sessions/${encodeURIComponent(id)}/output`,
        (event) => {
          if (event.kind === "plan") {
            setInvocation(event.invocation);
            steps.current = event.steps;
          }
          if (event.kind === "started" && steps.current.find((step) => step.index === event.index)?.kind === "session") disable(false);
          if (event.kind === "ask") {
            disable(true);
            setQuestion(event);
          }
          if (event.kind === "answered") setQuestion(undefined);
          const output = terminalOutput(event);
          if (output !== "") terminal.write(output);
          if (event.kind === "ended") {
            ended.current = true;
            disable(true);
            setState(
              event.stop?.why === "interrupted"
                ? "interrupted"
                : event.stop?.why === "declined"
                  ? "declined"
                  : event.failures > 0 || event.stop !== undefined
                    ? "failed"
                    : "passed",
            );
            terminal.write("\r\n[Session ended]\r\n");
          }
        },
        () => {
          disable(true);
          if (active.current && !ended.current && !refused.current)
            setFailure({ status: 0, message: "Session output disconnected. Reload this page to reconnect." });
        },
        undefined,
        fail,
      );
      dispose.current = () => {
        stop();
        input.dispose();
        terminal.dispose();
      };
    };
    void setup().catch(() => {
      if (active.current) setFailure({ status: 0, message: "The terminal could not start. Reload this page to reconnect." });
    });
    return () => {
      active.current = false;
      dispose.current();
    };
  }, [id]);
  const close = async () => {
    setClosing(true);
    const answer = await closeSession(id);
    if (!answer.ok) {
      setFailure(answer.failure);
      setClosing(false);
    }
  };
  return (
    <>
      <Header title={invocation?.command ?? "SSH terminal"} sub="120 columns × 32 rows">
        <Pill tone={state === "running" ? "active" : state === "passed" ? "ok" : "warn"}>{state}</Pill>
        {state === "running" ? (
          <button
            class="button danger"
            disabled={closing}
            onClick={() => {
              void close();
            }}
          >
            {closing ? "Closing…" : "Close session"}
          </button>
        ) : null}
      </Header>
      {failure === undefined ? null : <Problem failure={failure} />}
      {question === undefined ? null : <Question key={JSON.stringify(question)} id={id} question={question} />}
      <div class="terminal-scroll">
        <div ref={host} class="terminal" />
      </div>
      <p class="hint">Leaving this page keeps the session open. Use Close session to disconnect.</p>
    </>
  );
};
