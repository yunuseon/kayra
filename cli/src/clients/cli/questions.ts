import { createInterface } from "node:readline/promises";
import type { Io } from "../../core/interpreter/io.ts";
import type { Text } from "../../core/text/spans.ts";
import { typed } from "../../typed.ts";

/** The command line's questions: secret typing stays unseen, piped answers keep their order. */
export const questions = (render: (text: Text) => string) => {
  // eslint-disable-next-line functional/prefer-immutable-types -- resources belong to this reader and close with the plan
  const reading: { lines?: AsyncIterator<string>; close?: () => void } = {};
  const piped = async () => {
    if (reading.lines === undefined) {
      const terminal = createInterface({ input: process.stdin });
      // eslint-disable-next-line functional/immutable-data -- keep buffered lines across questions
      reading.lines = terminal[Symbol.asyncIterator]();
      // eslint-disable-next-line functional/immutable-data -- release stdin when the plan ends
      reading.close = () => { terminal.close(); };
    }
    const next = await reading.lines.next();
    return next.done === true ? "" : next.value;
  };
  const prompted = (prompt: string, secret: boolean) => {
    const { stdin } = process;
    if (!secret) {
      const terminal = createInterface({ input: stdin, output: process.stderr });
      return new Promise<string>((resolve) => {
        const done = (answer: string) => {
          resolve(answer);
          terminal.close();
        };
        // eslint-disable-next-line functional/immutable-data -- cancellation closes the outstanding question
        reading.close = () => { done(""); };
        terminal.once("SIGINT", () => { done(""); });
        terminal.once("close", () => { resolve(""); });
        void terminal.question(prompt).then(done, () => { done(""); });
      });
    }
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    return new Promise<string>((resolve) => {
      // eslint-disable-next-line functional/prefer-immutable-types -- typed characters until Enter or cancellation
      const state: { text: string; ended: boolean } = { text: "", ended: false };
      const done = (answer: string) => {
        if (state.ended) return;
        // eslint-disable-next-line functional/immutable-data -- finish once, even when a paste includes several lines
        state.ended = true;
        stdin.removeListener("data", key);
        stdin.removeListener("end", ended);
        stdin.setRawMode(wasRaw);
        stdin.pause();
        process.stderr.write("\n");
        resolve(answer);
      };
      const ended = () => { done(""); };
      const key = (chunk: string) => {
        Array.from(chunk).forEach((char) => {
          if (state.ended) return;
          if (char === "\r" || char === "\n") done(state.text);
          else if (char === "\u0003" || char === "\u0004") done("");
          else if (char === "\u007f" || char === "\b") {
            // eslint-disable-next-line functional/immutable-data -- remove one Unicode character
            state.text = Array.from(state.text).slice(0, -1).join("");
          } else {
            // eslint-disable-next-line functional/immutable-data -- append a typed character
            state.text += char;
          }
        });
      };
      // eslint-disable-next-line functional/immutable-data -- cancellation restores terminal mode
      reading.close = ended;
      stdin.on("data", key);
      stdin.once("end", ended);
      process.stderr.write(prompt);
    });
  };
  return typed<Pick<Io, "ask"> & { readonly close: () => void }>({
    ask: async (question) => {
      const prompt = render(question.text);
      if (process.stdin.isTTY) return prompted(prompt, question.kind === "secret");
      process.stderr.write(prompt);
      return piped();
    },
    close: () => { reading.close?.(); },
  });
};
