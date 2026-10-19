import { z } from "zod";
import type { OperationName, QueryName } from "../../core/operations/catalog.ts";
import { catalog } from "../wire/contract.ts";
import { options, schemas, querySchemas } from "../wire/schemas.ts";
import { typed } from "../../typed.ts";

const response = (description: string, schema: unknown, media = "application/json") => ({ description, content: { [media]: { schema } } } as const);
const ref = (name: keyof typeof schemas) => ({ $ref: `#/components/schemas/${name}` } as const);
const isQueryName = (name: OperationName): name is QueryName => Object.hasOwn(querySchemas, name);
const resultOf = (name: OperationName) => isQueryName(name) ? z.toJSONSchema(querySchemas[name]) : {};
const request = (input: unknown) => ({ required: true, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { input, options: z.toJSONSchema(options, { io: "input" }), confirm: { type: "string", description: "The real server's name, required before a change" } } } } } } as const);
const id = { name: "id", in: "path", required: true, schema: { type: "string" } };
const body = (properties: unknown, required: readonly string[]) => ({ required: true, content: { "application/json": { schema: { type: "object", properties, required, additionalProperties: false } } } } as const);
const write = (description: string) => ({ description, responses: { "204": { description: "Accepted" }, "404": { description: "No active resource" } } } as const);

export const openapi = (version: string) => ({
  openapi: "3.1.0",
  info: { title: "kayra local API", version, description: "127.0.0.1 only. Compatibility follows the fleet's pinned kayra version." },
  servers: [{ url: "/api" }],
  security: [{ bearer: [] }, { cookie: [] }],
  paths: {
    "/operations": { get: { responses: { "200": response("The operation catalog", { type: "array", items: ref("OperationInfo") }) } } },
    "/openapi.json": { get: { responses: { "200": response("This OpenAPI document", { type: "object" }) } } },
    "/fleet": { get: { responses: { "200": response("The fleet", ref("FleetFacts")) } } },
    "/directories": { get: { summary: "Browse local directories for app.check", parameters: [{ name: "path", in: "query", schema: { type: "string", default: "." } }], responses: { "200": response("Directories only, relative paths resolved from the fleet", ref("DirectoryListing")), "400": { description: "Directory cannot be read" } } } },
    ...Object.fromEntries<unknown>(catalog().flatMap(({ name, summary, kind, input }) => typed<readonly (readonly [string, unknown])[]>([
      [`/operations/${name}`, { post: { summary, operationId: name, requestBody: request(input), responses: kind === "plan" || kind === "session" ? {
        [kind === "session" ? "201" : "202"]: response("Started", { type: "object", properties: { [kind === "session" ? "session" : "run"]: { type: "string" } }, required: [kind === "session" ? "session" : "run"] }),
        "200": response("Dry run", ref("Preview")), "400": { description: "Invalid input" }, "403": { description: "Real server not confirmed" }, "409": { description: "Server busy" },
      } : { "200": response(summary, kind === "stream" ? ref("Status") : resultOf(name), kind === "stream" ? "text/event-stream" : "application/json") } } }],
      ...(kind === "plan" || kind === "session" ? [[`/operations/${name}/preview`, { post: { summary: `Preview: ${summary}`, requestBody: request(input), responses: { "200": response("Plan preview", ref("Preview")) } } }]] as const : []),
    ]))),
    "/runs": { get: { responses: { "200": response("Runs from this fleet", { type: "array", items: ref("RunSummary") }) } } },
    "/runs/{id}": { get: { parameters: [id], responses: { "200": response("A recorded run", ref("Run")), "404": { description: "No run" } } } },
    "/runs/{id}/events": { get: { parameters: [id], responses: { "200": { description: "Events replayed from the start, then followed until the run ends", content: { "text/event-stream": { schema: ref("RunEvent") }, "application/x-ndjson": { schema: ref("RunEvent") } } } } } },
    "/runs/{id}/answers": { post: { ...write("Answer the pending question; answers are never recorded"), parameters: [id], requestBody: body({ text: { type: "string" } }, ["text"]) } },
    "/runs/{id}/cancel": { post: { ...write("Cancel a run"), parameters: [id] } },
    "/sessions/{id}/output": { get: { parameters: [id], responses: { "200": response("Session events", ref("RunEvent"), "text/event-stream") } } },
    "/sessions/{id}/input": { post: { ...write("Send terminal input; input is never recorded"), parameters: [id], requestBody: body({ text: { type: "string" } }, ["text"]) } },
    "/sessions/{id}": { delete: { ...write("Close the session"), parameters: [id] } },
  },
  components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" }, cookie: { type: "apiKey", in: "cookie", name: "kayra_ui_<port>", description: "The browser's per-port cookie, set by the launch URL" } }, schemas: Object.fromEntries(Object.entries(schemas).map(([name, schema]) => {
    return [name, Object.fromEntries(Object.entries(z.toJSONSchema(schema)).filter(([key]) => key !== "$schema"))];
  })) },
} as const);
