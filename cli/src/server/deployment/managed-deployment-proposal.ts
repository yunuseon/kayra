import { z } from "zod";
import type { DataOwnership } from "../../contracts/owned-volume.ts";
import { parseDataOwnership } from "../../contracts/owned-volume.ts";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import { parseManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import type { RetainedInputsPort } from "../../contracts/service-inputs.ts";
import { serviceEffectAction } from "../../contracts/swarm-service.ts";
import { managedDeploymentEvidence } from "./managed-deployment-evidence.ts";
import { managedReleaseBaselines } from "./managed-release.ts";
import { parseManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import type { ManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import { managedSuccessfulInventoryCarry, managedRecoveredInventoryCarry, managedUnstartedInventoryCarry } from "./managed-lifecycle-inventory.ts";
import { prepareManagedTransition } from "./managed-transition.ts";
import { typed } from "../../lib/typed.ts";

const requestSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]).default(2), run: z.uuid(), action: z.string().max(80), createdAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  restore: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
}).strict().readonly();
type Request = z.input<typeof requestSchema>;
type Baseline = { readonly state: ManagedLifecycleStore; readonly source: ManagedLifecycleSource };
type Ports = RetainedInputsPort & { readonly now: () => number; readonly read: (digest: string) => Promise<string> };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Owner-only proposal construction. No writer, native or admission port exists here; callers still validate/accept the result under the lifecycle writer. */
export const managedDeploymentProposal = async (input: ManagedApplicationPlan, expected: DataOwnership, requested: Request, baseline: Baseline | null, ports: Ports) => {
  const request = requestSchema.parse(requested); const owner = parseDataOwnership(expected); const candidate = parseManagedApplicationPlan(input);
  if (!owner.ok || !candidate.ok || !same(owner.value, candidate.value.infrastructure.ownership) || !new RegExp(`^${owner.value.incarnation}:[1-9][0-9]*$`).test(request.action) || !Number.isSafeInteger(Number(request.action.split(":")[1]))) throw new Error("managed proposal ownership disagrees");
  const evidence = baseline === null ? null : await managedDeploymentEvidence(baseline.state, baseline.source, ports);
  if (evidence !== null && !same(evidence.state.owner, owner.value)) throw new Error("managed proposal baseline ownership disagrees");
  if (evidence?.state.operation.run === request.run) {
    if (evidence.source.candidate.commit !== candidate.value.commit || evidence.source.candidate.artifact !== candidate.value.artifact || evidence.source.action !== request.action || evidence.source.restore !== request.restore) throw new Error("managed proposal request identity conflicts");
    return evidence.source;
  }
  const now = ports.now(); const deadline = request.createdAt + 90_000;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(deadline) || now < request.createdAt || now >= deadline || evidence !== null && evidence.state.operation.phase !== "complete") throw new Error("managed proposal is expired or a lifecycle operation is unresolved");
  const before = evidence?.source ?? null; const state = evidence?.state; const previous = evidence?.active?.release ?? null;
  const retired = (() => {
    if (before === null || state === undefined) return Object.freeze([]);
    if (state.operation.unstartedAt !== null) return before.retired;
    if (state.operation.outcome === "deployed") return Object.freeze(before.retired.filter((entry) => before.candidate.services[entry.plan.service] === undefined));
    const recovery = state.operation.recovery; if (recovery?.phase !== "verified") throw new Error("managed proposal lacks verified inactive inventory");
    const inactive = Object.freeze(recovery.nodes.flatMap((node) => {
      const spec = before.candidate.services[node.name]; const barrier = node.child?.barrier;
      return spec?.role === "retained-dependency" && before.previous?.source.application.services[node.name] === undefined && barrier?.phase === "complete" ? Object.freeze([Object.freeze({ plan: spec, barrier })]) : Object.freeze([]);
    }));
    return Object.freeze([...before.retired.filter((item) => !inactive.some((entry) => entry.plan.service === item.plan.service) && before.previous?.source.application.services[item.plan.service] === undefined), ...inactive]);
  })();
  const transition = await prepareManagedTransition(previous?.source.application ?? null, candidate.value, retired.filter((entry) => candidate.value.services[entry.plan.service] !== undefined).map((entry) => entry.plan), ports, { deadline, now: ports.now });
  if (!transition.ok) throw new Error(transition.error);
  const active = previous === null ? Object.freeze([]) : managedReleaseBaselines(previous);
  const retained = Object.freeze(Object.values(transition.value.plan.services).flatMap((spec) => {
    if (spec.role !== "retained-dependency") return Object.freeze([]);
    const prior = active.find((entry) => entry.name === spec.service);
    if (prior !== undefined) return Object.freeze([typed<ManagedLifecycleSource["retained"][number]>({ ...prior, kind: "active" })]);
    const retirement = retired.find((entry) => entry.plan.service === spec.service); const barrier = retirement?.barrier; const step = barrier?.steps.at(-1);
    if (barrier === undefined) return Object.freeze([]);
    if (barrier.phase !== "complete" || barrier.proof === null || step?.effect !== "scrub") throw new Error("managed proposal reactivation lacks a complete barrier");
    return Object.freeze([typed<ManagedLifecycleSource["retained"][number]>({ name: spec.service, kind: "barrier", native: barrier.proof.native, action: { ...barrier.action, effect: "scrub", action: serviceEffectAction(barrier.action.action, "scrub", step.attempt) } })]);
  }));
  const source = parseManagedLifecycleSource({ ...request, candidate: transition.value.plan, previous, retired, retained });
  const carried = before === null ? managedSuccessfulInventoryCarry(null, source) : state?.operation.unstartedAt !== null ? managedUnstartedInventoryCarry(before, source) : state.operation.outcome === "deployed" ? managedSuccessfulInventoryCarry(before, source) : managedRecoveredInventoryCarry(before, state.operation.recovery, source);
  if (!carried.ok) throw new Error(carried.error); if (ports.now() >= deadline) throw new Error("managed proposal preparation deadline expired");
  return source;
};
