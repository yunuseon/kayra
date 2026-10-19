import { describe, expect, test, vi } from "vitest";
import type { RunEvent } from "../../cli/src/clients/wire/contract.gen.ts";
import { defaults, fields, inputOf } from "../src/operations.ts";
import { orderedInput, terminalOutput } from "../src/session.ts";
import type { Answer } from "../src/api.ts";

describe("catalog forms", () => {
  const schema = {
    type: "object",
    properties: {
      server: { type: "string", minLength: 1 },
      ref: { type: "string" },
      command: { type: "array", items: { type: "string" } },
      noPrs: { type: "boolean", default: false },
    },
    required: ["server", "command"],
  };
  test("optional blanks are omitted, booleans preserved, and argument spaces stay inside their argument", () => {
    const values = defaults(schema, { server: "lab", command: ["printf", "two words"], noPrs: true });
    expect(inputOf(schema, values)).toEqual({ server: "lab", command: ["printf", "two words"], noPrs: true });
    expect(inputOf(schema, { ...values, noPrs: false, ref: "feature/ui" })).toEqual({
      server: "lab",
      command: ["printf", "two words"],
      noPrs: false,
      ref: "feature/ui",
    });
  });
  test("unsupported schemas cannot silently become usable text inputs", () => {
    expect(
      fields({ properties: { nested: { type: "object" }, numbers: { type: "array", items: { type: "number" } } } }).every(
        (field) => !field.supported,
      ),
    ).toBe(true);
  });
});

describe("terminal transport", () => {
  test("output keeps terminal escape sequences; questions and answers never become terminal text", () => {
    expect(terminalOutput({ kind: "output", stream: "stdout", chunk: "\u001b[31mred\u001b[0m" })).toBe("\u001b[31mred\u001b[0m");
    expect(terminalOutput({ kind: "said", stream: "err", text: ["ssh: ", { text: "refused", tone: "bad" }] })).toBe("ssh: refused\r\n");
    const question: RunEvent = { kind: "ask", prompt: "Password", secret: true };
    expect(terminalOutput(question)).toBe("");
    expect(terminalOutput({ kind: "answered" })).toBe("");
  });
  test("key presses wait for earlier requests, and a refusal stops subsequent input", async () => {
    const release: { current: () => void } = { current: () => undefined };
    const gate = new Promise<void>((resolve) => {
      release.current = resolve;
    });
    const send = vi.fn(async (text: string): Promise<Answer<undefined>> => {
      if (text === "a") {
        await gate;
        return { ok: true, value: undefined };
      }
      return { ok: false, failure: { status: 404, message: "session ended" } };
    });
    const failed = vi.fn();
    const input = orderedInput(send, failed);
    input("a");
    input("b");
    input("c");
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledTimes(1);
    });
    release.current();
    await vi.waitFor(() => {
      expect(failed).toHaveBeenCalledWith({ status: 404, message: "session ended" });
    });
    expect(send.mock.calls.map(([text]) => text)).toEqual(["a", "b"]);
  });
});
