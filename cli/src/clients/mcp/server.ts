import { inputRequired, inputResponse, Server, type CallToolResult } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { heading } from "../../core/interpreter/events.ts";
import type { Fleet } from "../../core/fleet/model.ts";
import { operation, type Invocation } from "../../core/operations/catalog.ts";
import { hasPlan, invocation, isQuery, isStream, planOf, serverOf, stream, type Context } from "../../core/operations/dispatch.ts";
import { render } from "../../core/plan/describe.ts";
import type { Plan } from "../../core/plan/model.ts";
import { verbose } from "../../core/recipes/steps.ts";
import { settle } from "../../core/status/updates.ts";
import { answer } from "../wire/queries.ts";
import { statusJson } from "../wire/status.ts";
import { words } from "../wire/words.ts";
import { confirmations, run, type Confirmation } from "./run.ts";
import { operationOf, runOptions, tools } from "./tools.ts";
import { typed } from "../../lib/typed.ts";

/** What kayra mcp serves with: the core's context, and how paths are shortened. */
export type Mcp = { readonly context: Context; readonly short: (text: string) => string };

/** Servers with a change running in this process: one at a time each. */
export type Busy = { readonly has: (server: string) => boolean; readonly add: (server: string) => void; readonly delete: (server: string) => void };

const said = (text: string, isError = false) => typed<CallToolResult>({ content: [{ type: "text", text }], ...(isError ? { isError } : {}) });

const answered = (value: unknown) =>
  typed<CallToolResult>({
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(typeof value === "object" && value !== null ? { structuredContent: value } : {}),
  });

const instructions = (fleet: Fleet) =>
  [
    "kayra runs a fleet of servers: provisioning, host setup, the apps on them, and their checks. These tools are its operations, as the kayra command line has them.",
    "",
    "The fleet's servers:",
    ...fleet.servers.map((each) => `- ${each.name}: ${each.kind} on ${each.target}, ${each.domain}`),
    "",
    "- dryRun: true on a plan's tool lists its steps and runs nothing: use it before a change.",
    "- A change to a server whose target is not multipass is approved by the operator first; down and app_purge every time, with the server's name typed.",
    "- No password passes through here: SOPS opens secrets.yml with the operator's age key, which may ask for Touch ID on their Mac.",
    "- verify, plan, status and validate change nothing.",
  ].join("\n").slice(0, 4000);

/** What the operator typed for each confirmation, or the request to ask them first. */
const confirmed = (asks: readonly Confirmation[], responses: Readonly<Record<string, unknown>> | undefined) => {
  if (asks.length === 0) return { typed: [] };
  const views = asks.map((each) => inputResponse(responses, each.key));
  if (views.every((view) => view.kind === "missing"))
    return {
      ask: inputRequired({
        inputRequests: Object.fromEntries(asks.map((each) => [each.key, inputRequired.elicit({
          message: `${each.warning}\nType ${each.expect} to confirm.`,
          requestedSchema: { type: "object", properties: { typed: { type: "string", title: `Type ${each.expect}` } }, required: ["typed"] },
        })])),
      }),
    };
  return { typed: views.map((view) => (view.kind === "elicit" && view.action === "accept" && typeof view.content?.["typed"] === "string" ? view.content["typed"] : undefined)) };
};

type Call = {
  readonly name: string;
  readonly arguments?: Readonly<Record<string, unknown>>;
  readonly progressToken?: string | number;
  readonly responses?: Readonly<Record<string, unknown>>;
  readonly signal: NonNullable<Context["signal"]>;
  readonly progress: (progress: number, total: number, message: string) => Promise<void>;
};

const runPlan = async (mcp: Mcp, busy: Busy, call: Invocation, plan: Plan, asked: Call) => {
  const options = runOptions.parse({ dryRun: asked.arguments?.["dryRun"], verbose: asked.arguments?.["verbose"] });
  const steps = options.verbose ? verbose(plan) : plan;
  if (options.dryRun) return said(render(steps).join("\n"));
  const target = serverOf(mcp.context, call);
  const changes = operation(call.name).effect !== "reads" && target !== undefined;
  if (changes && busy.has(target.name)) return said(`a change on ${target.name} is still running: wait for it to end`, true);
  const asks = confirmed(confirmations(steps), asked.responses);
  if ("ask" in asks) return asks.ask;
  if (changes) busy.add(target.name);
  try {
    const ran = await run(steps, {
      about: heading(words(call), target, mcp.context.version),
      short: mcp.short,
      bare: operation(call.name).bare === true,
      typed: asks.typed,
      signal: asked.signal,
      began: (index, total, title) => { void asked.progress(index, total, title); },
    });
    return said(ran.text, !ran.passed);
  } finally {
    if (changes) busy.delete(target.name);
  }
};

/** One tools/call: the tool's operation, its input through the core's one gate, then by kind. */
const callTool = async (mcp: Mcp, busy: Busy, asked: Call) => {
  const name = operationOf(asked.name);
  if (name === undefined) return said(`no such tool: ${asked.name}`, true);
  const input = Object.fromEntries(Object.entries(asked.arguments ?? {}).filter(([key]) => !Object.hasOwn(runOptions.shape, key)));
  const call = invocation(name, operation(name).kind === "plan" ? input : asked.arguments);
  if (!call.ok) return said(call.error, true);
  const context = { ...mcp.context, signal: asked.signal };
  if (isQuery(call.value)) {
    const result = await answer(context, call.value.name, call.value.input);
    return result.ok ? answered(result.value) : said(result.error, true);
  }
  if (isStream(call.value)) {
    const { initial, updates } = stream(context, call.value.name, call.value.input);
    return answered(statusJson(await settle(initial, updates)));
  }
  if (hasPlan(call.value)) {
    const plan = planOf(context, call.value);
    return plan.ok ? runPlan({ ...mcp, context }, busy, call.value, plan.value, asked) : said(plan.error, true);
  }
  return said(`${asked.name} is not offered here`, true);
};

/** The MCP server over the core: tools/list from the catalog, tools/call through invocation(). */
export const mcpServer = (mcp: Mcp, busy: Busy) => {
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- the low-level server: tools/list and tools/call stay kayra's, through invocation()
  const server = new Server(
    { name: "kayra", version: mcp.context.version },
    { capabilities: { tools: {} }, instructions: instructions(mcp.context.fleet) },
  );
  server.setRequestHandler("tools/list", () => ({ tools: [...tools(mcp.context.fleet)] }));
  server.setRequestHandler("tools/call", (request, ctx) => {
    const token = request.params._meta?.progressToken;
    return callTool(mcp, busy, {
      name: request.params.name,
      ...(request.params.arguments === undefined ? {} : { arguments: request.params.arguments }),
      ...(token === undefined ? {} : { progressToken: token }),
      ...(ctx.mcpReq.inputResponses === undefined ? {} : { responses: ctx.mcpReq.inputResponses }),
      signal: ctx.mcpReq.signal,
      progress: (progress, total, message) =>
        token === undefined ? Promise.resolve() : ctx.mcpReq.notify({ method: "notifications/progress", params: { progressToken: token, progress, total, message } }),
    });
  });
  return server;
};

/** kayra mcp: the server on this process's stdin and stdout, one change per server at a time. */
export const serveMcp = (mcp: Mcp, onError: (message: string) => void) => {
  const running = new Set<string>();
  const busy: Busy = {
    has: (server) => running.has(server),
    // eslint-disable-next-line functional/immutable-data -- the servers a change runs on now, shared by the connection's calls
    add: (server) => { running.add(server); },
    // eslint-disable-next-line functional/immutable-data -- see above
    delete: (server) => { running.delete(server); },
  };
  return serveStdio(() => mcpServer(mcp, busy), { onerror: (error) => { onError(error.message); } });
};
