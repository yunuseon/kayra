import type { IncomingMessage, ServerResponse } from "node:http";

/** The request body, refused past `limit` bytes. */
export const body = async (request: IncomingMessage, limit = 1 << 20): Promise<Buffer | undefined> => {
  const chunks = await Array.fromAsync(request, (chunk: Buffer) => chunk);
  const all = Buffer.concat(chunks);
  return all.length > limit ? undefined : all;
};

export const json = async (request: IncomingMessage): Promise<unknown> => {
  const raw = await body(request);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw.toString("utf8"));
    return parsed;
  } catch {
    return undefined;
  }
};

export const send = (response: ServerResponse, status: number, text: string, type = "text/plain; charset=utf-8"): void => {
  response.writeHead(status, { "Content-Type": type });
  response.end(text);
};
