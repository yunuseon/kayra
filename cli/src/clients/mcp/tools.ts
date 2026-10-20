import { z } from "zod";
import type { Fleet } from "../../core/fleet/model.ts";
import { operation, operationNames, type Operation, type OperationName, type QueryName } from "../../core/operations/catalog.ts";
import { querySchemas, schemas } from "../wire/schemas.ts";
import { typed } from "../../lib/typed.ts";

/** How MCP offers an operation: as a tool, or not, and why. */
export type Offer = { readonly tool: string } | { readonly refused: string };

/**
 * How MCP reaches each operation. The compiler refuses a catalog operation
 * this table leaves out; a tool's name is the operation's, `.` spelled `_`
 * (Claude's API takes no dots in a tool name).
 */
export const reaches = {
  up: { tool: "up" },
  provision: { tool: "provision" },
  deploy: { tool: "deploy" },
  setup: { tool: "setup" },
  plan: { tool: "plan" },
  verify: { tool: "verify" },
  apps: { tool: "apps" },
  hosts: { tool: "hosts" },
  ssh: { refused: "an interactive shell, which an agent cannot hold: ssh_exec runs a command" },
  "ssh.exec": { tool: "ssh_exec" },
  down: { tool: "down" },
  adopt: { tool: "adopt" },
  "backup.test": { tool: "backup_test" },
  "app.init": { tool: "app_init" },
  "app.check": { tool: "app_check" },
  "app.values": { tool: "app_values" },
  "app.launch": { tool: "app_launch" },
  "app.config.set": { tool: "app_config_set" },
  "app.secret.import": { tool: "app_secret_import" },
  "app.secret.generate": { tool: "app_secret_generate" },
  "app.purge": { tool: "app_purge" },
  "app.runs": { tool: "app_runs" },
  "app.log": { tool: "app_log" },
  "app.deploy": { tool: "app_deploy" },
  "app.releases": { tool: "app_releases" },
  "app.rollback": { tool: "app_rollback" },
  job: { tool: "job" },
  status: { tool: "status" },
  validate: { tool: "validate" },
  doctor: { tool: "doctor" },
  certs: { tool: "certs" },
  version: { tool: "version" },
} as const satisfies Readonly<Record<OperationName, Offer>>;

/** The operations offered as tools, by their tool's name. */
export const offered = Object.freeze(
  operationNames.flatMap((name) => {
    const offer: Offer = reaches[name];
    return "tool" in offer ? [[offer.tool, name] as const] : [];
  }),
);

export const operationOf = (tool: string) => offered.find(([name]) => name === tool)?.[1];

/** What a plan's tool takes besides the operation's input. */
export const runOptions = z.strictObject({
  dryRun: z.boolean().default(false).describe("List the plan's steps and run nothing"),
  verbose: z.boolean().default(false).describe("Ansible's own output, as with -v"),
});

const effectSaid = (each: Operation) => {
  if (each.effect === "reads") return "Changes nothing.";
  if (each.effect === "destroys") return "Irreversible: the operator approves every call, and types the server's name before it runs.";
  return each.local === true || each.scope === "fleet" || each.scope === "repo"
    ? "Changes files on this machine."
    : "Changes the server: on one that is not multipass, the operator approves it first.";
};

const kindSaid = (each: Operation) =>
  each.kind === "plan" ? (each.bare === true ? " Its output is its answer." : " Runs a plan of steps; dryRun lists them and runs nothing.") : "";

type JsonSchema = Readonly<Record<string, unknown>>;
const isSchema = (value: unknown): value is JsonSchema => typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON Schema without its dialect: Claude Code reads it as draft 2020-12 either way. */
// eslint-disable-next-line functional/prefer-immutable-types -- a Zod schema: immutable, a class the rule cannot see into
const plain = (schema: z.ZodType, io: "input" | "output") =>
  typed<JsonSchema>(Object.fromEntries(Object.entries(z.toJSONSchema(schema, { io })).filter(([key]) => key !== "$schema")));

const optionsSchema = plain(runOptions, "input");

/** A tool's schemas as MCP has them: an object at the root, its properties plain JSON. */
const objectSchema = z.looseObject({ type: z.literal("object"), properties: z.record(z.string(), z.json()).optional() });

/** The input's JSON Schema, with the fleet's servers as the only choices (the command line's choice()), and a plan's options. */
const inputSchema = (each: Operation, servers: readonly string[]) => {
  const base = plain(each.input, "input");
  const properties = {
    ...(isSchema(base["properties"]) ? base["properties"] : {}),
    ...(each.kind === "plan" && isSchema(optionsSchema["properties"]) ? optionsSchema["properties"] : {}),
  };
  const server = properties["server"];
  return objectSchema.parse({ ...base, properties: isSchema(server) && servers.length > 0 ? { ...properties, server: { ...server, enum: servers } } : properties });
};

const isQueryName = (name: OperationName): name is QueryName => Object.hasOwn(querySchemas, name);

/** An answer's schema, where it is an object: MCP's structured content is one. */
const outputSchema = (name: OperationName) => {
  const schema = name === "status" ? schemas.Status : isQueryName(name) ? querySchemas[name] : undefined;
  if (schema === undefined) return undefined;
  const json = objectSchema.safeParse(plain(schema, "output"));
  return json.success ? json.data : undefined;
};

/** Every tool, as tools/list answers. */
export const tools = (fleet: Fleet) => {
  const servers = fleet.servers.map((each) => each.name);
  return Object.freeze(offered.map(([tool, name]) => {
    const each = operation(name);
    const output = outputSchema(name);
    return {
      name: tool,
      title: each.summary,
      description: `${each.summary} ${effectSaid(each)}${kindSaid(each)}`,
      inputSchema: inputSchema(each, servers),
      ...(output === undefined ? {} : { outputSchema: output }),
      annotations: { readOnlyHint: each.effect === "reads", destructiveHint: each.effect === "destroys", openWorldHint: each.scope !== "repo" },
      ...(each.effect === "destroys" ? { _meta: { "anthropic/requiresUserInteraction": true } } : {}),
    } as const;
  }));
};
