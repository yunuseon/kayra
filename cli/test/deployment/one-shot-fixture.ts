/* eslint-disable functional/no-let, functional/immutable-data, functional/prefer-immutable-types, @typescript-eslint/require-await -- models native objects, not coordinator state */
import { strict as assert } from "node:assert";
import type { JobPlan } from "../../src/contracts/one-shot-job.ts";
import { jobName } from "../../src/contracts/one-shot-job.ts";
import { oneShotJob } from "../../src/server/runtime/one-shot-job.ts";

export const jobPlan = (): JobPlan => ({ version: 1,
  scope: { app: "shop", incarnation: "02970402-9c43-4ec0-b025-d92786ff6902", run: "fef226f4-8ca4-4b07-8fb9-50fc0423129d", step: "schema", purpose: "migration", attempt: 1 },
  image: "localhost:5000/shop/web@sha256:" + "a".repeat(64), command: ["node", "migrate.mjs"], entrypoint: null,
  environment: { TOKEN: { kind: "secret", key: "TOKEN" } }, resources: { memoryBytes: 128 * 1024 * 1024, nanoCpus: 250_000_000 },
  networks: [], deadline: 10_000, stopGraceSeconds: 30,
});
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

export const jobRuntime = (plan = jobPlan()) => {
  let value: Record<string, unknown> | undefined; let serial = 0; let executions = 0; let clock = 1000;
  const calls: { readonly method: string; readonly path: string; readonly body: unknown }[] = [];
  const api = { request: async (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => {
    calls.push({ method, path, body });
    if (method === "POST" && path.startsWith("/containers/create?")) {
      if (value !== undefined) return { status: 409, value: {} };
      assert.ok(object(body));
      const id = (++serial).toString(16).padStart(64, "0");
      value = { Id: id, Name: "/" + jobName(plan.scope), Config: body, HostConfig: body["HostConfig"], State: { Status: "created", ExitCode: 0 } };
      return { status: 201, value: { Id: id } };
    }
    const id = path.split("/")[2]?.split("?")[0];
    if (value === undefined || (id !== value["Id"] && id !== jobName(plan.scope))) return { status: 404, value: {} };
    if (method === "GET") return { status: 200, value };
    if (method === "DELETE") { value = undefined; return { status: 204, value: null }; }
    if (path.endsWith("/start")) {
      executions++; value = { ...value, State: { Status: "exited", ExitCode: 0 } }; return { status: 204, value: null };
    }
    throw new Error("unexpected native request");
  } };
  const native = oneShotJob(api, () => clock);
  return { plan, api, native, calls, executions: () => executions, raw: () => value,
    now: (next: number) => { clock = next; }, clock: () => clock,
    state: (status: string, exitCode = 0) => { assert.ok(value !== undefined); value = { ...value, State: { Status: status, ExitCode: exitCode } }; },
  };
};
