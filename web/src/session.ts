import type { RunEvent, Text } from "../../cli/src/clients/wire/contract.gen.ts";
import type { Answer, Failure } from "./api.ts";

const plain = (text: Text) =>
  typeof text === "string" ? text : text.map((span) => (typeof span === "string" ? span : span.text)).join("");
export const terminalOutput = (event: RunEvent) =>
  event.kind === "output" ? event.chunk : event.kind === "said" ? `${plain(event.text)}\r\n` : "";

export const orderedInput = (send: (text: string) => Promise<Answer<undefined>>, failed: (failure: Failure) => void) => {
  const pending = { current: Promise.resolve(true) };
  return (text: string) => {
    pending.current = pending.current.then(async (ready) => {
      if (!ready) return false;
      const result = await send(text);
      if (!result.ok) failed(result.failure);
      return result.ok;
    });
  };
};
