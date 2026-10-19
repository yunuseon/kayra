import type { Preview, RunOptions, RunSummary } from "../../cli/src/clients/api/contract.gen.ts";
import type { Draft } from "./operations.ts";
import { typed } from "./typed.ts";

/** What went wrong asking kayra: its own words, as it said them. */
export type Failure = { readonly status: number; readonly message: string };
export type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Failure };

/**
 * kayra's answers, typed by the contract both sides compile against
 * (cli/src/clients/api/contract.gen.ts): the one place a value from the server takes a type.
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-unnecessary-type-parameters -- see above
const trusted = <T>(value: unknown) => value as T;

const answer = async <T>(response: Response, read: (response: Response) => Promise<unknown>) =>
  response.ok
    ? typed<Answer<T>>({ ok: true, value: trusted<T>(await read(response)) })
    : typed<Answer<T>>({ ok: false, failure: { status: response.status, message: (await response.text()).trim() } });

const attempt = async <T>(work: () => Promise<Answer<T>>) => {
  try {
    return await work();
  } catch {
    return typed<Answer<T>>({ ok: false, failure: { status: 0, message: "Cannot reach kayra. Check that kayra serve is still running." } });
  }
};

export const get = <T>(path: string) =>
  attempt(() => fetch(path).then((response) => answer<T>(response, (response) => response.json())));

const post = <T>(path: string, body: unknown) =>
  attempt(async () =>
    answer<T>(
      await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      async (response) => (response.status === 204 ? undefined : response.json()),
    ),
  );

export const preview = (command: Draft, options: RunOptions) =>
  post<Preview>(`/api/operations/${command.name}/preview`, { input: command.input, options });

export const start = (
  command: Draft,
  options: RunOptions,
  confirm?: string,
) =>
  post<{ readonly run: string } | { readonly session: string }>(`/api/operations/${command.name}`, { input: command.input, options, ...(confirm === undefined ? {} : { confirm }) });

export const operation = <T>(name: string, input: unknown = {}) => post<T>(`/api/operations/${name}`, { input });

export const answerRun = (id: string, text: string) =>
  post<undefined>(`/api/runs/${encodeURIComponent(id)}/answers`, { text });

export const cancelRun = (id: string) => post<undefined>(`/api/runs/${encodeURIComponent(id)}/cancel`, {});

export const sessionInput = (id: string, text: string) =>
  post<undefined>(`/api/sessions/${encodeURIComponent(id)}/input`, { text });
export const closeSession = (id: string) =>
  attempt(async () =>
    answer<undefined>(await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }), () => Promise.resolve(undefined)),
  );

export const runs = () => get<readonly RunSummary[]>("/api/runs");

/**
 * A server-sent stream: each value as it comes, `done` once the server says
 * it has said everything (its `end` event), never reconnecting by itself.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names what the stream carries, as the contract has it
export const stream = <T>(
  path: string,
  each: (value: T) => void,
  done: () => void,
  body?: unknown,
  failed?: (failure: Failure) => void,
) => {
  const stop = new AbortController();
  const follow = async () => {
    const response = await fetch(path, {
      signal: stop.signal,
      ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      failed?.({ status: response.status, message: (await response.text()).trim() });
      return;
    }
    if (response.body === null) throw new Error("No stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    // eslint-disable-next-line functional/prefer-immutable-types -- retain partial SSE frames between reads
    const pending: { text: string } = { text: "" };
    const read = async () => {
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
  void follow()
    .catch(() => {
      if (!stop.signal.aborted) failed?.({ status: 0, message: "The connection to kayra was interrupted." });
    })
    .finally(done);
  return () => {
    stop.abort();
  };
};
