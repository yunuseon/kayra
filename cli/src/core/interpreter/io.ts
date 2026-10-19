import type { Text } from "../text/spans.ts";

/**
 * What kayra asks the operator: to type a word that confirms (a server's
 * name before destroying it), or a password, asked hidden, kept in memory for
 * this run only and never shown, logged or recorded.
 */
export type Question =
  | { readonly kind: "confirm"; readonly text: Text; readonly expect: string }
  | { readonly kind: "secret"; readonly text: Text };

/** Where the interpreter talks to the operator. */
export type Io = {
  /** What a command reports: doctor's checks, notes. */
  readonly out: (text: Text) => void;
  /** Around it: why a step stopped the plan, what a quiet step said, a warning before a question. */
  readonly err: (text: Text) => void;
  /** The operator's answer; "" for none (Ctrl-C, no more input), which stops what needed it. */
  readonly ask: (question: Question) => Promise<string>;
  /**
   * Without a terminal (the web interface, the API): what a step shows arrives
   * here instead, and no step reads kayra's stdin. Without it, steps share
   * kayra's terminal.
   */
  readonly output?: (chunk: string, stream: "stdout" | "stderr") => void;
  /** Without a terminal: what the operator types into a step that talks with them (a shell), as it comes. */
  readonly input?: (deliver: (chunk: string) => void) => () => void;
  /** Without a terminal: the size of the operator's, for a step that talks with them. */
  readonly size?: { readonly columns: number; readonly rows: number };
  /** Stops the running step: SIGINT to its program, SIGTERM if it is still there after a while. */
  readonly signal?: Stopping;
};

/** What kayra uses of an AbortSignal. */
type Stopping = {
  readonly aborted: boolean;
  readonly addEventListener: (type: "abort", listener: () => void, options: { readonly once: true }) => void;
  readonly removeEventListener: (type: "abort", listener: () => void) => void;
};

export const isStopped = (signal: Io["signal"]): boolean => signal?.aborted === true;

/** Cancellation also ends a question; a late answer cannot restart the plan. */
export const ask = async (io: Io, question: Question): Promise<string> => {
  if (isStopped(io.signal)) return "";
  return new Promise((resolve, reject) => {
    const done = (answer: string): void => {
      io.signal?.removeEventListener("abort", stopped);
      resolve(answer);
    };
    const stopped = (): void => { done(""); };
    io.signal?.addEventListener("abort", stopped, { once: true });
    void io.ask(question).then(done, (error: unknown) => {
      io.signal?.removeEventListener("abort", stopped);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
};
