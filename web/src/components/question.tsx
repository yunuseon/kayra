import { useEffect, useRef, useState } from "preact/hooks";
import type { RunEvent } from "../../../cli/src/clients/api/contract.gen.ts";
import { answerRun, type Failure } from "../api.ts";
import { Problem, Spans } from "./ui.tsx";

export const Question = ({ id, question }: { readonly id: string; readonly question: Extract<RunEvent, { readonly kind: "ask" }> }) => {
  const [typed, setTyped] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<Failure | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  const answer = async (text: string) => {
    setPending(true);
    setTyped("");
    const result = await answerRun(id, text);
    if (!result.ok) {
      setFailure(result.failure);
      setPending(false);
    }
  };
  return (
    <form
      class="ask"
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) void answer(typed);
      }}
    >
      <label for="run-answer">
        <Spans text={question.prompt} />
      </label>
      <input
        id="run-answer"
        ref={input}
        type={question.secret ? "password" : "text"}
        autoComplete="off"
        value={typed}
        disabled={pending}
        onInput={(event) => {
          setTyped(event.currentTarget.value);
        }}
        spellcheck={false}
      />
      <button type="submit" class="button primary" disabled={pending}>
        {pending ? "Sending…" : "Answer"}
      </button>
      <button
        type="button"
        class="button"
        disabled={pending}
        onClick={() => {
          void answer("");
        }}
      >
        Decline
      </button>
      {failure === undefined ? null : <Problem failure={failure} />}
    </form>
  );
};
