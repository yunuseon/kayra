import type { RunEvent, Text } from "../../cli/src/clients/api/contract.gen.ts";
import type { Answer, Failure } from "./api.ts";

const plain = (text: Text): string =>
  typeof text === "string" ? text : text.map((span) => (typeof span === "string" ? span : span.text)).join("");
export const terminalOutput = (event: RunEvent): string =>
  event.kind === "output" ? event.chunk : event.kind === "said" ? `${plain(event.text)}\r\n` : "";

export const orderedInput = (send: (text: string) => Promise<Answer<undefined>>, failed: (failure: Failure) => void) => {
  const pending = { current: Promise.resolve(true) };
  return (text: string): void => {
    pending.current = pending.current.then(async (ready) => {
      if (!ready) return false;
      const result = await send(text);
      if (!result.ok) failed(result.failure);
      return result.ok;
    });
  };
};
