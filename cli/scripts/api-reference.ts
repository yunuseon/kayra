type ObjectValue = Readonly<Record<string, unknown>>;
const isObject = (value: unknown): value is ObjectValue => typeof value === "object" && value !== null && !Array.isArray(value);
const object = (value: unknown): ObjectValue => (isObject(value) ? value : {});
const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === "string" ? value : "");
const cell = (value: string): string => value.replaceAll("|", "\\|").replaceAll("\n", " ").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const code = (value: string): string => `\`${cell(value)}\``;
const literal = (value: unknown): string => JSON.stringify(value);

const typeOf = (value: unknown): string => {
  const schema = object(value);
  if (typeof schema["$ref"] === "string") return schema["$ref"].split("/").at(-1) ?? "";
  if ("const" in schema) return literal(schema["const"]);
  if (Array.isArray(schema["enum"])) return schema["enum"].map(literal).join(" or ");
  if (Array.isArray(schema["anyOf"])) return schema["anyOf"].map(typeOf).join(" or ");
  if (Array.isArray(schema["type"])) return schema["type"].map(text).join(" or ");
  return schema["type"] === "array" ? `array of ${typeOf(schema["items"])}` : text(schema["type"]) || "any JSON value";
};
const constraints = (schema: ObjectValue): string =>
  [
    typeof schema["minLength"] === "number" ? `Minimum length: ${String(schema["minLength"])}.` : "",
    typeof schema["minItems"] === "number" ? `Minimum items: ${String(schema["minItems"])}.` : "",
    typeof schema["minimum"] === "number" ? `Minimum: ${String(schema["minimum"])}.` : "",
    typeof schema["maximum"] === "number" ? `Maximum: ${String(schema["maximum"])}.` : "",
    typeof schema["pattern"] === "string" ? `Pattern: ${code(schema["pattern"])}.` : "",
  ]
    .filter((value) => value !== "")
    .join(" ");
const properties = (value: unknown): string => {
  const schema = object(value);
  const fields = Object.entries(object(schema["properties"]));
  if (fields.length === 0) return "No input fields.\n";
  return [
    "| Field | Type | Required | Default | Description |",
    "| --- | --- | --- | --- | --- |",
    ...fields.map(([name, value]) => {
      const field = object(value);
      const description = [cell(text(field["description"])), constraints(field)].filter((value) => value !== "").join(" ");
      return `| ${code(name)} | ${code(typeOf(field))} | ${list(schema["required"]).includes(name) ? "yes" : "no"} | ${"default" in field ? code(literal(field["default"])) : "—"} | ${description || "—"} |`;
    }),
    "",
  ].join("\n");
};
const bodyOf = (operation: ObjectValue): ObjectValue =>
  object(object(object(object(operation["requestBody"])["content"])["application/json"])["schema"]);
const responses = (operation: ObjectValue): string =>
  [
    "| Status | Response | Content type |",
    "| --- | --- | --- |",
    ...Object.entries(object(operation["responses"])).map(([status, value]) => {
      const response = object(value);
      const content = Object.keys(object(response["content"])).map(code).join(", ");
      return `| ${code(status)} | ${cell(text(response["description"]))} | ${content || (status === "204" ? "no body" : "—")} |`;
    }),
    "",
  ].join("\n");
const parameters = (operation: ObjectValue): string => {
  const entries = list(operation["parameters"]);
  return entries.length === 0
    ? ""
    : [
        "| Parameter | In | Type | Required |",
        "| --- | --- | --- | --- |",
        ...entries.map((value) => {
          const parameter = object(value);
          return `| ${code(text(parameter["name"]))} | ${cell(text(parameter["in"]))} | ${code(typeOf(parameter["schema"]))} | ${parameter["required"] === true ? "yes" : "no"} |`;
        }),
        "",
      ].join("\n");
};

const guide = `---
title: Local API
description: The local kayra API, its authentication, operations, runs and terminal sessions.
---

<!-- Generated from the OpenAPI contract by npm run contract. Edit cli/scripts/api-reference.ts. -->

The API runs on the operator's machine and uses the same operation catalog,
plans and guards as the CLI and browser. Start it from a fleet:

\`\`\`bash
kayra serve --api --no-open         # programs only
kayra serve --ui --api              # browser and programs together
\`\`\`

Routes live under \`/api\`, without a separate API version. The fleet's pinned
kayra version defines the contract; upgrading kayra replaces the API and bundled
UI together. \`GET /api/openapi.json\` supplies the full OpenAPI 3.1 document,
including request and response schemas. \`GET /api/operations\` supplies operation
names, summaries, scopes, effects, kinds and input JSON Schemas.

## Discovery and authentication

With \`--api\`, kayra writes \`<fleet>/.cache/serve.json\` with \`url\` (including
\`/api\`), \`token\` and \`pid\`, readable only by its owner (mode 0600). It removes
the file on shutdown. Read it afresh after restarting kayra: the port and token
belong to that launch. A second API listener for the same fleet is refused
while the discovery file's process is alive.

Programs send \`Authorization: Bearer <token>\`. The listener binds to
127.0.0.1; every request must use its exact host and port (127.0.0.1 or localhost).
The browser exchanges the launch URL's token for a per-port HttpOnly,
SameSite=Strict cookie. Cookie-authenticated writes require an Origin matching
the request's host and port. Bearer-authenticated writes require no Origin.
There is no CORS. Bearer access and discovery are enabled only with \`--api\`;
the UI uses the same API with its cookie.

This Node 24 example runs from the fleet root and reads only the version:

\`\`\`js
import { readFile } from "node:fs/promises";

const { url, token } = JSON.parse(await readFile(".cache/serve.json", "utf8"));
const response = await fetch(url + "/operations/version", {
  method: "POST",
  headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  body: JSON.stringify({ input: {} }),
});
if (!response.ok) throw new Error(await response.text());
console.log(await response.json());
\`\`\`

## Invoking an operation

Send JSON to \`POST /api/operations/<name>\`:

\`\`\`json
{
  "input": { "server": "shop-test" },
  "options": { "verbose": true, "dryRun": false }
}
\`\`\`

\`input\` defaults to an empty object. The operation's schema checks its fields;
unknown fields are refused. The core also checks server/app names and whether
the chosen server supports the operation. Relative repository paths start at
the fleet root.

Plans return \`202 {"run":"<id>"}\`; terminal sessions return
\`201 {"session":"<id>"}\`. Queries return JSON directly with status 200.
Status streams answers as they arrive. The schemas and status tables below
come from the OpenAPI document.

### Run options

OPTIONS

For a plan or session, append \`/preview\` to its operation path to inspect the
steps without running them. \`dryRun: true\` also returns the preview, with status
200, instead of starting it. Verbose mode changes the same Ansible steps as the
CLI's \`--verbose\`. Terminal dimensions are set when the session starts.

### Confirmations and questions

Before changing a server whose target is not Multipass, supply its exact name
as \`confirm\` beside \`input\` and \`options\`:

\`\`\`json
{
  "input": { "server": "shop-prod" },
  "confirm": "shop-prod"
}
\`\`\`

The server checks this even for bearer callers. The plans retain their own
guards: Hetzner/home changes require the fleet's clean main branch and pinned
kayra package; destruction can ask for another typed confirmation. Only one
run or session may be live per server.

Follow a run's events. An \`ask\` event carries \`prompt\`, \`secret\` and, for a
confirmation, \`expect\`. Answer through
\`POST /api/runs/<id>/answers\` with \`{"text":"..."}\`. Answers are not recorded;
a secret belongs in a password field and should be cleared after submission.
Secrets are never asked: SOPS opens a server's secrets.yml with the operator's
age key (once per run). Sudo passwords reach the local hosts helper through stdin.

### Events and cancellation

\`GET /api/runs/<id>/events\` replays recorded events, then follows the run until
it ends. SSE is the default: JSON appears in \`data:\` frames, followed by an
\`event: end\` frame. Send \`Accept: application/x-ndjson\` for one JSON event per
line. Status and session output also accept NDJSON. Clients should read the
stream incrementally and stop when it ends; a reconnect replays from the start.

EVENTS

\`POST /api/runs/<id>/cancel\` cancels a run, including a pending question. It
sends SIGINT to the child process group, then SIGTERM after ten seconds if
needed. \`DELETE /api/sessions/<id>\` closes a terminal session the same way.
Stopping \`kayra serve\` cancels its work, waits for children, closes the listener
and removes discovery. Runs are recorded under \`.cache/ui/runs/*.jsonl\`.

Session output carries the same run events. Forward each output \`chunk\` to a
terminal emulator and send its input with
\`POST /api/sessions/<id>/input\` and \`{"text":"..."}\`. Send input requests in
order. Input requests are not stored separately; terminal output, including
anything echoed by the shell, is part of the run record. Leaving a browser
page or closing an event stream keeps the session running.

### Errors

Errors have a plain-text body. Invalid inputs/plans return 400, missing launch
authentication returns 401, host/origin/confirmation refusals return 403, missing
resources return 404, and a server with live work returns 409. An upstream query
can return 502; unexpected server failures return 500. Answer/input endpoints
return 404 when nothing is waiting. A successful answer, cancellation, input or
session-close request returns 204 with no body.
`;

export const apiReference = (document: unknown): string => {
  const spec = object(document);
  const paths = Object.entries(object(spec["paths"]));
  const schemas = object(object(spec["components"])["schemas"]);
  const first = object(paths.find(([path]) => path.startsWith("/operations/"))?.[1]);
  const options = object(bodyOf(object(first["post"]))["properties"])["options"];
  const events = list(object(schemas["RunEvent"])["oneOf"] ?? object(schemas["RunEvent"])["anyOf"]);
  const eventTable = [
    "| Event | Fields |",
    "| --- | --- |",
    ...events.map((value) => {
      const fields = object(object(value)["properties"]);
      return `| ${code(text(object(fields["kind"])["const"]))} | ${
        Object.keys(fields)
          .filter((name) => name !== "kind")
          .map(code)
          .join(", ") || "—"
      } |`;
    }),
  ].join("\n");
  const operations = paths
    .filter(([path]) => path.startsWith("/operations/") && !path.endsWith("/preview"))
    .map(([path, value]) => {
      const operation = object(object(value)["post"]);
      const preview = paths.some(([candidate]) => candidate === `${path}/preview`);
      return [
        `### ${code(text(operation["operationId"]))}`,
        "",
        text(operation["summary"]),
        "",
        code(`POST /api${path}`),
        "",
        properties(object(bodyOf(operation)["properties"])["input"]),
        ...(preview ? [`Preview: ${code(`POST /api${path}/preview`)}. Returns a JSON plan with status 200.`, ""] : []),
        responses(operation),
      ].join("\n");
    });
  const resources = paths
    .filter(([path]) => !path.startsWith("/operations/"))
    .flatMap(([path, value]) =>
      Object.entries(object(value)).map(([method, value]) => {
        const operation = object(value);
        return [
          `### ${code(`${method.toUpperCase()} /api${path}`)}`,
          "",
          text(operation["summary"] ?? operation["description"]),
          "",
          parameters(operation),
          ...("requestBody" in operation ? [properties(bodyOf(operation))] : []),
          responses(operation),
        ].join("\n");
      }),
    );
  return [
    guide.replace("OPTIONS", properties(options)).replace("EVENTS", eventTable),
    "## Operations",
    "",
    ...operations,
    "## Resources",
    "",
    ...resources,
    "",
  ].join("\n");
};
