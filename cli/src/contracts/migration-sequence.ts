import { createHash } from "node:crypto";
import { z } from "zod";
import { parseMigrationStep } from "./rollout.ts";
import type { Migration } from "./rollout.ts";
import { parseJobPlan, parseJobTemplate } from "./one-shot-job.ts";
import type { JobTemplate } from "./one-shot-job.ts";
import { all, err, ok } from "../lib/result.ts";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({ version: z.literal(1), deployment: z.string().regex(/^[0-9a-f]{64}$/),
  scope: z.object({ app: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/), incarnation: z.uuid(), run: z.uuid() }).strict().readonly(),
  policy: z.object({ schedulingSeconds: z.literal(90), cleanupSeconds: z.literal(30), maximumAttempts: z.literal(8), timeoutCeilingSeconds: positive.max(86400) }).strict().readonly(),
  steps: z.array(z.object({ definition: z.unknown(), template: z.unknown() }).strict()).min(1).max(128).readonly(),
}).strict().readonly();
export type MigrationSequencePlan = {
  readonly version: 1; readonly deployment: string; readonly scope: { readonly app: string; readonly incarnation: string; readonly run: string };
  readonly policy: { readonly schedulingSeconds: 90; readonly cleanupSeconds: 30; readonly maximumAttempts: 8; readonly timeoutCeilingSeconds: number };
  readonly steps: readonly { readonly definition: Migration; readonly template: JobTemplate }[];
};

/** Private normalized description, not a builder proposal or an admission grant. */
export const parseMigrationSequencePlan = (input: unknown) => {
  const parsed = schema.safeParse(input); if (!parsed.success) return err("invalid migration sequence plan");
  const value = parsed.data;
  const steps = all(value.steps.map((step) => {
    const definition = parseMigrationStep(step.definition); const template = parseJobTemplate(step.template, value.scope.app);
    if (!definition.ok || !template.ok || definition.value.timeout_seconds > value.policy.timeoutCeilingSeconds ||
      (definition.value.recovery.kind === "status-probe" && definition.value.recovery.timeout_seconds > value.policy.timeoutCeilingSeconds)) return err("invalid migration step or operator timeout ceiling");
    const commands = definition.value.recovery.kind === "status-probe" ? [definition.value.command, definition.value.recovery.command] : [definition.value.command];
    if (commands.some((command) => !parseJobPlan({ ...template.value, command, deadline: 1,
      scope: { ...value.scope, step: definition.value.id, purpose: "migration", attempt: 1 } }).ok)) return err("unsupported migration or probe command");
    return ok(Object.freeze({ definition: definition.value, template: template.value }));
  }));
  if (!steps.ok || new Set(steps.value.map((step) => step.definition.id)).size !== steps.value.length) return err("invalid or duplicate migration steps");
  return ok<MigrationSequencePlan>(Object.freeze({ ...value, steps: Object.freeze(steps.value) }));
};

export const migrationSequenceDigest = (input: MigrationSequencePlan) => {
  const parsed = parseMigrationSequencePlan(input); if (!parsed.ok) throw new Error(parsed.error);
  return createHash("sha256").update(JSON.stringify(parsed.value)).digest("hex");
};
