import type { CommandInput, Preview, RunSummary } from "../../cli/src/clients/api/contract.ts";

/** What went wrong asking kayra ui: its own words, as it said them. */
export type Failure = { readonly status: number; readonly message: string };
export type Answer<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Failure };

/**
 * kayra ui's answers, typed by the contract both sides compile against
 * (cli/src/clients/api/contract.ts): the one place a value from the server takes a type.
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
    async (response) => (response.status === 204 || response.status === 202 ? undefined : response.json()),
  );

export const preview = (command: CommandInput): Promise<Answer<Preview>> => post("/api/plan", command);

export const startRun = (command: CommandInput, confirm?: string): Promise<Answer<{ readonly id: string }>> =>
  post("/api/runs", { command, ...(confirm === undefined ? {} : { confirm }) });

export const answerRun = (id: string, text: string): Promise<Answer<undefined>> => post(`/api/runs/${encodeURIComponent(id)}/answer`, { text });

export const cancelRun = (id: string): Promise<Answer<undefined>> => post(`/api/runs/${encodeURIComponent(id)}/cancel`, {});

export const runs = (): Promise<Answer<readonly RunSummary[]>> => get("/api/runs");

/**
 * A server-sent stream: each value as it comes, `done` once the server says
 * it has said everything (its `end` event), never reconnecting by itself.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the caller names what the stream carries, as the contract has it
export const stream = <T>(path: string, each: (value: T) => void, done: () => void): (() => void) => {
  const source = new EventSource(path);
  const close = (): void => {
    source.close();
  };
  source.addEventListener("message", (event: MessageEvent<string>) => {
    each(trusted<T>(JSON.parse(event.data)));
  });
  source.addEventListener("end", () => {
    close();
    done();
  });
  source.addEventListener("error", () => {
    close();
    done();
  });
  return close;
};
