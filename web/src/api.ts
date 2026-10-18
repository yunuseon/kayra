import type { Preview, RunSummary } from "../../cli/src/clients/api/contract.gen.ts";

import type { CommandInput } from "./commands.ts";

/** What went wrong asking kayra: its own words, as it said them. */
export type Failure = { readonly status: number; readonly message: string };
export type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Failure };

/**
 * kayra's answers, typed by the contract both sides compile against
 * (cli/src/clients/api/contract.gen.ts): the one place a value from the server takes a type.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unnecessary-type-parameters -- see above
const trusted = <T>(value: unknown): T => value as T;

const answer = async <T>(response: Response, read: (response: Response) => Promise<unknown>): Promise<Answer<T>> =>
  response.ok
    ? { ok: true, value: trusted<T>(await read(response)) }
    : { ok: false, failure: { status: response.status, message: (await response.text()).trim() } };

export const get = async <T>(path: string): Promise<Answer<T>> => answer<T>(await fetch(path), (response) => response.json());

export const getText = async (path: string): Promise<Answer<string>> => answer<string>(await fetch(path), (response) => response.text());

const post = async <T>(path: string, body: unknown): Promise<Answer<T>> =>
  answer<T>(
    await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    async (response) => (response.status === 204 ? undefined : response.json()),
  );

const inputOf = (command: CommandInput) => {
  return { input: Object.fromEntries(Object.entries(command).filter(([key]) => key !== "name")) };
};
export const preview = (command: CommandInput): Promise<Answer<Preview>> => post(`/api/operations/${command.name}/preview`, inputOf(command));

export const startRun = async (command: CommandInput, confirm?: string): Promise<Answer<{ readonly id: string }>> => {
  const started = await post<{ readonly run: string }>(`/api/operations/${command.name}`, { ...inputOf(command), ...(confirm === undefined ? {} : { confirm }) });
  return started.ok ? { ok: true, value: { id: started.value.run } } : started;
};

export const operation = <T>(name: string, input: unknown = {}): Promise<Answer<T>> => post(`/api/operations/${name}`, { input });

export const answerRun = (id: string, text: string): Promise<Answer<undefined>> => post(`/api/runs/${encodeURIComponent(id)}/answers`, { text });

export const cancelRun = (id: string): Promise<Answer<undefined>> => post(`/api/runs/${encodeURIComponent(id)}/cancel`, {});

export const runs = (): Promise<Answer<readonly RunSummary[]>> => get("/api/runs");

/**
 * A server-sent stream: each value as it comes, `done` once the server says
 * it has said everything (its `end` event), never reconnecting by itself.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names what the stream carries, as the contract has it
export const stream = <T>(path: string, each: (value: T) => void, done: () => void, body?: unknown): (() => void) => {
  const stop = new AbortController();
  const follow = async (): Promise<void> => {
    const response = await fetch(path, { signal: stop.signal, ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
    if (!response.ok || response.body === null) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // eslint-disable-next-line functional/prefer-immutable-types -- retain partial SSE frames between reads
    const pending: { text: string } = { text: "" };
    const read = async (): Promise<void> => {
      const chunk = await reader.read();
      if (chunk.done) return;
      const frames = (pending.text + decoder.decode(chunk.value, { stream: true })).split("\n\n");
      // eslint-disable-next-line functional/immutable-data -- the unfinished frame is completed by the next chunk
      pending.text = frames.pop() ?? "";
      frames.forEach((frame) => {
        if (frame.startsWith("data: ")) each(trusted<T>(JSON.parse(frame.slice(6))));
      });
      await read();
    };
    await read();
  };
  void follow().catch(() => undefined).finally(done);
  return () => { stop.abort(); };
};
