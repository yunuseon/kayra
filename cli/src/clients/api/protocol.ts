import { z } from "zod";
import { effects, kinds, operationNames, scopes, type QueryName } from "../../core/operations/catalog.ts";
import { serverKinds } from "../../core/fleet/settings.ts";
import { serverTargets } from "../../core/fleet/model.ts";
import { parts } from "../../core/plan/model.ts";
import { stopReasons } from "../../core/interpreter/progress.ts";
import { machineStates, reachStates } from "../../core/status/model.ts";
import { tones } from "../../core/text/spans.ts";
import { verdicts } from "../../core/validation/findings.ts";
import { releasesSchema, runsSchema } from "../../core/ctl/answers.ts";

const tone = z.enum(tones);
const span = z.union([z.string(), z.object({ tone: tone.exactOptional(), text: z.string(), href: z.string().exactOptional() })]);
const line = z.array(span);
const text = z.union([z.string(), line]);
const part = z.enum(parts);
const listed = z.object({ index: z.number().int(), kind: z.string(), title: z.string(), command: z.string().exactOptional(), part: part.exactOptional(), opens: part.exactOptional() });
const invocation = z.object({ command: z.string(), server: z.string().exactOptional(), about: z.array(z.string()) });
const stop = z.enum(stopReasons);
const state = z.enum(["running", "passed", "failed", "interrupted", "declined"]);
const summary = z.object({ id: z.string(), command: z.string(), server: z.string().exactOptional(), started: z.string(), state, session: z.boolean() });
const ended = z.object({ kind: z.literal("ended"), failures: z.number(), stop: z.object({ index: z.number(), why: stop }).exactOptional(), ms: z.number(), footer: z.array(line) });
const event = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("plan"), invocation, steps: z.array(listed) }),
  z.object({ kind: z.literal("started"), index: z.number() }),
  z.object({ kind: z.literal("done"), index: z.number(), failed: z.boolean(), stopped: z.boolean(), why: z.string().exactOptional(), ms: z.number() }),
  ended,
  z.object({ kind: z.literal("output"), stream: z.enum(["stdout", "stderr"]), chunk: z.string() }),
  z.object({ kind: z.literal("said"), stream: z.enum(["out", "err"]), text }),
  z.object({ kind: z.literal("ask"), prompt: text, secret: z.boolean(), expect: z.string().exactOptional() }),
  z.object({ kind: z.literal("answered") }),
]);
const reach = z.enum(reachStates);
const verdict = z.enum(verdicts);
const serverCommand = z.enum(["up", "provision", "deploy", "setup", "plan", "verify", "apps", "down", "adopt", "backup.test"]);
const serverFacts = z.object({
  name: z.string(), kind: z.enum(serverKinds), target: z.enum(serverTargets), domain: z.string(), apps: z.array(z.string()),
  commands: z.array(z.union([serverCommand, z.literal("job")])),
});

export const options = z.strictObject({
  verbose: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  columns: z.number().int().min(1).max(1000).default(120),
  rows: z.number().int().min(1).max(1000).default(32),
});
export const requestBody = z.strictObject({ input: z.unknown().exactOptional(), options: options.exactOptional(), confirm: z.string().exactOptional() });

export const schemas = {
  Tone: tone, Span: span, Line: line, Text: text, Part: part, Listed: listed, Invocation: invocation, Stop: stop, RunState: state,
  RunEvent: event, RunSummary: summary,
  Run: summary.extend({ events: z.array(event) }),
  Preview: z.object({ invocation, steps: z.array(listed), changes: z.boolean() }),
  ServerCommand: serverCommand,
  ServerFacts: serverFacts,
  FleetFacts: z.object({ fleet: z.string(), version: z.string(), servers: z.array(serverFacts) }),
  DirectoryListing: z.object({ path: z.string(), parent: z.string(), directories: z.array(z.object({ name: z.string(), path: z.string() })) }),
  ReachState: reach,
  Status: z.object({ servers: z.array(z.object({
    name: z.string(), kind: z.string(), target: z.string(), domain: z.string(), apps: z.array(z.string()),
    machine: z.object({ state: z.enum(machineStates), address: z.string().nullable(), from: z.enum(["inventory", "opentofu"]).nullable(), reason: z.string().nullable() }),
    ssh: z.object({ port: z.number(), state: reach, ms: z.number().nullable(), error: z.string().nullable() }),
    https: z.object({ url: z.string(), state: reach, status: z.number().nullable(), ms: z.number().nullable(), error: z.string().nullable() }).nullable(),
  })) }),
  Validation: z.object({ result: verdict, servers: z.array(z.object({ name: z.string(), kind: z.string(), target: z.string(), result: verdict, findings: z.array(z.object({ result: verdict, text: z.string(), hint: z.string().nullable() })) })) }),
  AppRuns: runsSchema, AppReleases: releasesSchema,
  OperationInfo: z.object({ name: z.enum(operationNames), summary: z.string(), scope: z.enum(scopes), effect: z.enum(effects), kind: z.enum(kinds), input: z.record(z.string(), z.unknown()) }),
} as const;

export const querySchemas = {
  validate: schemas.Validation, version: z.string(), "app.runs": schemas.AppRuns, "app.releases": schemas.AppReleases, "app.log": z.string(),
} satisfies Readonly<Record<QueryName, z.ZodType>>;
