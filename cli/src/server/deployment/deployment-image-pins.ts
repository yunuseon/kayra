import { createHash } from "node:crypto";
import { parseApplicationPlan } from "../../contracts/application-plan.ts";
import { parseRolloutPlan, rolloutWorkloadDigest } from "../../contracts/rollout-plan.ts";
import { parseDeploymentImagePins } from "../../contracts/deployment-image-pins.ts";
import type { DeploymentImagePins } from "../../contracts/deployment-image-pins.ts";
import type { BuildPorts } from "../../contracts/build-artifact.ts";
import { parseLifecycleEnvelope } from "./lifecycle-envelope.ts";
import { httpReleasePlan, terminalHttp } from "./http-state.ts";
import { verifiedRegistration } from "./verified-registration.ts";

type Reference = { readonly plan: string; readonly workload: string; readonly commit: string; readonly role: DeploymentImagePins["plans"][number]["roles"][number] };

/** Runs under the owning application writer; no consumer reads its private journals. */
export const deploymentImagePins = async (app: string, input: unknown, ports: Pick<BuildPorts, "read">) => {
  const parsed = parseLifecycleEnvelope(input); if (!parsed.ok) throw new Error("image pins lack a valid lifecycle envelope");
  const envelope = parsed.value; const registration = verifiedRegistration(app, envelope); const runtime = envelope.registrationReceipt?.runtime;
  if (runtime === undefined) throw new Error("image pins lack verified runtime");
  const state = envelope.http;
  const release = (value: NonNullable<typeof state>["active"], role: Reference["role"]) => value === null ? Object.freeze([]) : Object.freeze([Object.freeze({ plan: httpReleasePlan(value), workload: value.plan, commit: value.commit, role })]);
  const latest = state?.requests.at(-1);
  const references: readonly Reference[] = [
    ...release(state?.active ?? null, "active"), ...release(state?.lastKnownGood ?? null, "last-known-good"),
    ...release(latest?.previous ?? null, "rollback"),
    ...(state?.requests ?? []).filter((item) => !terminalHttp(item.phase)).flatMap<Reference>((item) => Object.freeze([
      Object.freeze<Reference>({ plan: httpReleasePlan(item), workload: item.plan, commit: item.commit, role: item.phase === "held" ? "unresolved" : "candidate" }), ...release(item.previous, "rollback"),
    ])),
    ...[...(envelope.rollouts ?? []), ...(envelope.rollout === undefined ? [] : [envelope.rollout])].filter((item) => item.completion === undefined && !state?.requests.some((child) => child.request === item.preparation.run && terminalHttp(child.phase))).map<Reference>((item) => Object.freeze({
      plan: item.preparation.plan, workload: item.preparation.workload, commit: item.commit, role: item.preparation.phase === "held" ? "unresolved" : "candidate",
    })),
  ];
  const plans = await Promise.all([...new Set(references.map((item) => item.plan))].toSorted().map(async (digest) => {
    const content = await ports.read(digest); if (createHash("sha256").update(content).digest("hex") !== digest) throw new Error("image pin plan integrity failed");
    const raw: unknown = JSON.parse(content); const full = parseRolloutPlan(raw); const projection = full.ok ? { ok: true as const, value: full.value.workload } : parseApplicationPlan(raw);
    if (!projection.ok) throw new Error("image pin plan is unsupported");
    const plan = projection.value; const workload = full.ok ? rolloutWorkloadDigest(full.value) : digest;
    const matching = references.filter((item) => item.plan === digest);
    if (JSON.stringify(plan.registration) !== JSON.stringify(registration) || matching.some((item) => item.workload !== workload || item.commit !== plan.commit)) throw new Error("image pin plan ownership changed");
    return Object.freeze({ plan: digest, workload, commit: plan.commit, roles: Object.freeze([...new Set(matching.map((item) => item.role))].toSorted()), images: Object.freeze([...new Set(Object.values(plan.services).map((service) => service.image))].toSorted()) });
  }));
  const result = parseDeploymentImagePins({ version: 1, app, incarnation: registration.incarnation, runtime, scope: "coordinator-plans", gcSafe: false, plans });
  if (!result.ok) throw new Error(result.error); return result.value;
};
