import { afterEach, expect, test, vi } from "vitest";
import { get, preview, start, stream } from "../src/api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});
const body = (value: unknown): unknown => {
  if (typeof value !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(value);
};

test("previews and launches preserve run options, confirmation and session identity", async () => {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response("{}"))
    .mockResolvedValueOnce(new Response('{"session":"s1"}', { status: 201 }));
  vi.stubGlobal("fetch", fetcher);
  const draft = { name: "ssh", input: { server: "prod" } } as const;
  await preview(draft, { verbose: true, dryRun: true });
  expect(fetcher.mock.calls[0]?.[0]).toBe("/api/operations/ssh/preview");
  expect(body(fetcher.mock.calls[0]?.[1]?.body)).toEqual({ input: { server: "prod" }, options: { verbose: true, dryRun: true } });
  expect(await start(draft, {}, "prod")).toEqual({ ok: true, value: { session: "s1" } });
  expect(body(fetcher.mock.calls[1]?.[1]?.body)).toEqual({ input: { server: "prod" }, options: {}, confirm: "prod" });
});

test("SSE reads fragmented frames and UTF-8, and completes without reconnecting", async () => {
  const bytes = new TextEncoder().encode('data: {"text":"ö"}\n\ndata: {"text":"next"}\n\nevent: end\ndata: {}\n\n');
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes.slice(0, 16));
          controller.enqueue(bytes.slice(16, 17));
          controller.enqueue(bytes.slice(17, 27));
          controller.enqueue(bytes.slice(27));
          controller.close();
        },
      }),
    ),
  );
  vi.stubGlobal("fetch", fetcher);
  const each = vi.fn();
  const done = vi.fn();
  const failed = vi.fn();
  stream("/api/operations/status", each, done, { input: { offline: true } }, failed);
  await vi.waitFor(() => {
    expect(done).toHaveBeenCalledTimes(1);
  });
  expect(each.mock.calls).toEqual([[{ text: "ö" }], [{ text: "next" }]]);
  expect(failed).not.toHaveBeenCalled();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(body(fetcher.mock.calls[0]?.[1]?.body)).toEqual({ input: { offline: true } });
});

test("HTTP refusals and unavailable servers become visible failures", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("session missing", { status: 404 }))
      .mockRejectedValue(new Error("offline")),
  );
  const each = vi.fn();
  const done = vi.fn();
  const failed = vi.fn();
  stream("/api/sessions/missing/output", each, done, undefined, failed);
  await vi.waitFor(() => {
    expect(done).toHaveBeenCalledTimes(1);
  });
  expect(failed).toHaveBeenCalledWith({ status: 404, message: "session missing" });
  expect(each).not.toHaveBeenCalled();
  expect(await get("/api/fleet")).toMatchObject({ ok: false, failure: { status: 0 } });
});
