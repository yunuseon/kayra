import { parseManagedExecutionContext } from "../../contracts/managed-execution-context.ts";
import { managedLifecycleDescription, managedLifecycleSourceDigest } from "./managed-lifecycle-source.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";

/** The owner publishes operational inputs without exposing release certificates or journal layout to platform policy. */
export const managedSourceContext = (input: ManagedLifecycleSource) => {
  const description = managedLifecycleDescription(input); const source = description.source;
  const context = parseManagedExecutionContext({ version: 1, protocol: "managed-v3", runtime: "swarm", owner: source.candidate.infrastructure.ownership,
    run: source.run, action: source.action, source: managedLifecycleSourceDigest(source), application: source.candidate, previous: source.previous?.source.application ?? null,
    allocationRequired: source.version !== 1, createdAt: source.createdAt, admissionDeadline: description.admissionDeadline, deadline: description.deadline });
  if (!context.ok) throw new Error(context.error); return context.value;
};
