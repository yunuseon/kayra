import { createHash } from "node:crypto";
import { z } from "zod";
import { parseManagedApplicationPlan, managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import type { RetainedInputsPort } from "../../contracts/service-inputs.ts";
import { migrationReasonSchema } from "../../contracts/migration-resolution.ts";
import { managedHistorySelection } from "./managed-history-selection.ts";
import { managedDeploymentEvidence } from "./managed-deployment-evidence.ts";
import type { ManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import { prepareManagedTransition } from "./managed-transition.ts";
import { settledMigrationPrefix } from "./migration-prefix.ts";

const requested = z.object({ run: z.uuid(), action: z.string().max(80), createdAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), reason: migrationReasonSchema }).strict().readonly();
type Request = z.input<typeof requested>;
type Ports = RetainedInputsPort & { readonly now: () => number; readonly read: (digest: string) => Promise<string> };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Policy and pinned inventory only; callers still authenticate artifacts and current runtime authority. */
export const managedForwardRecoveryBaseline = (state: ManagedLifecycleStore, source: ManagedLifecycleSource, candidate: ManagedApplicationPlan, requestInput: Request) => {
  const request = requested.parse(requestInput); const operation = state.operation; const owner = state.owner;
  if (operation.phase !== "held" || !operation.admitted || operation.settled || operation.recoverySource !== null || request.createdAt < (operation.compatibilityFencedAt ?? (source.version === 3 ? operation.enteredAt : Infinity)) || source.candidate.rollout.strategy !== "maintenance" ||
    candidate.rollout.strategy !== "maintenance" || !candidate.grants.maintenance || !same(candidate.infrastructure.ownership, owner) || !same(candidate.host, source.candidate.host) || !same(candidate.infrastructure.overlay, source.candidate.infrastructure.overlay) ||
    request.run === operation.run || !new RegExp(`^${owner.incarnation}:[1-9][0-9]*$`).test(request.action) || !Number.isSafeInteger(Number(request.action.split(":")[1])) || Number(request.action.split(":")[1]) <= state.sequence) throw new Error("forward recovery requires a distinct granted maintenance request against the held data epoch");
  const migrations = settledMigrationPrefix(operation.preparation?.sequence ?? null); if (migrations === undefined) throw new Error("forward recovery requires resolved migration outcomes");
  const known = [...Object.values(source.candidate.services), ...Object.values(source.previous?.source.application.services ?? {}), ...source.retired.map((item) => item.plan)];
  if (Object.values(candidate.services).some((service) => service.role === "retained-dependency" && known.some((prior) => prior.service === service.service && prior.role !== "retained-dependency"))) throw new Error("forward recovery cannot repurpose a consumer as a retained dependency");
  const required = [...Object.values(source.candidate.services), ...Object.values(source.previous?.source.application.services ?? {}), ...source.retired.filter((item) => candidate.services[item.plan.service] !== undefined).map((item) => item.plan)];
  const retained = required.filter((service) => service.role === "retained-dependency").filter((service, index, all) => all.findIndex((prior) => prior.service === service.service) === index);
  if (known.some((service) => service.role === "retained-dependency" && retained.some((prior) => prior.service === service.service && managedServiceDigest(prior) !== managedServiceDigest(service)))) throw new Error("forward recovery retained inventory disagrees");
  return Object.freeze({ migrations, retained: Object.freeze(retained) });
};

/** Reviewable successor description only. It cannot release admission, supersede a run, authorize builds or start workloads. */
export const managedForwardRecoveryProposal = async (input: ManagedApplicationPlan, requestInput: Request, baseline: { readonly state: ManagedLifecycleStore; readonly source: ManagedLifecycleSource }, ports: Ports) => {
  const request = requested.parse(requestInput); const candidate = parseManagedApplicationPlan(input); if (!candidate.ok) throw new Error("invalid forward recovery candidate");
  const deadline = request.createdAt + 90_000; const now = ports.now();
  if (!Number.isSafeInteger(deadline) || !Number.isSafeInteger(now) || now < request.createdAt || now >= deadline) throw new Error("forward recovery proposal deadline expired");
  const read = async (identity: string) => {
    const left = Math.min(10_000, deadline - ports.now()); if (left <= 0) throw new Error("forward recovery metadata deadline expired");
    const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, left);
    try { const bytes = await Promise.race([Promise.resolve().then(() => ports.read(identity)).catch(() => undefined), timeout.promise]); if (bytes === undefined || ports.now() >= deadline) throw new Error("forward recovery metadata unavailable or expired"); return bytes; } finally { clearTimeout(timer); }
  };
  const evidence = await managedDeploymentEvidence(baseline.state, baseline.source, { read }); const { state, source } = evidence; const operation = state.operation;
  const { migrations, retained } = managedForwardRecoveryBaseline(state, source, candidate.value, request);
  const transition = await prepareManagedTransition(null, candidate.value, retained, ports, { deadline, now: ports.now }); if (!transition.ok) throw new Error(transition.error);
  const inspectionDeadline = performance.now() + Math.min(10_000, deadline - ports.now());
  const selection = await managedHistorySelection(state, { restore: null, plan: managedApplicationDigest(transition.value.plan), commit: transition.value.plan.commit }, { read, expired: () => ports.now() >= deadline || performance.now() >= inspectionDeadline });
  const historical = "historical" in selection ? selection.historical : selection; if (historical !== null && historical.epoch !== state.compatibilityEpoch) throw new Error("forward recovery cannot select a commit from an earlier data epoch");
  if (ports.now() >= deadline) throw new Error("forward recovery proposal deadline expired");
  return Object.freeze({ version: 1 as const, kind: "managed-forward-recovery-proposal" as const, request, deadline,
    blocked: Object.freeze({ run: operation.run, source: operation.source, checkpoint: hash(state), compatibilityEpoch: state.compatibilityEpoch, originalDeadline: operation.deadline }),
    candidate: transition.value.plan, plan: managedApplicationDigest(transition.value.plan), migrations,
    previous: null, retired: source.retired, rollbackEligible: false as const, resources: transition.value.resources,
    prerequisites: Object.freeze(["audit-operator-decision", "fence-prior-effects", "transfer-pending-admission", "verify-candidate-before-promotion"] as const),
  });
};
