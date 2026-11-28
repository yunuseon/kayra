import { createHash } from "node:crypto";
import { parseApplicationPlan } from "../../contracts/application-plan.ts";
import { parseDeploymentHealth } from "../../contracts/deployment-health.ts";
import type { DeploymentHealth } from "../../contracts/deployment-health.ts";
import type { BuildPorts } from "../../contracts/build-artifact.ts";
import { serviceEffectAction } from "../../contracts/swarm-service.ts";
import type { ServiceObservation, SwarmServicePort } from "../../contracts/swarm-service.ts";
import type { HttpState, HttpVerifiedRelease } from "./http-state.ts";
import { parseLifecycleEnvelope } from "./lifecycle-envelope.ts";
import { verifiedRegistration } from "./verified-registration.ts";

type Ports = Pick<BuildPorts, "read" | "now"> & Pick<SwarmServicePort, "observe">;
const identities = (state: HttpState) => {
  const latest = state.requests.at(-1);
  const certified = (value: HttpVerifiedRelease | null | undefined) => value === null || value === undefined ? Object.freeze([]) : Object.freeze([Object.freeze({ plan: value.plan, action: value.action, effect: value.effect })]);
  return Object.freeze([...certified(state.active), ...certified(state.lastKnownGood), ...certified(latest?.previous),
    ...(latest?.steps ?? []).filter((step) => step.effect === "apply" || step.effect === "restore").map((step) => Object.freeze({ plan: step.plan, action: serviceEffectAction(latest?.action ?? "", step.effect, step.attempt), effect: step.effect })),
  ]);
};
const summarize = (name: string, incarnation: string, observation: ServiceObservation, known: ReturnType<typeof identities>) => {
  const empty = (state: DeploymentHealth["services"][number]["state"]) => Object.freeze({ name, state, currentTasks: state === "missing" ? 0 : null, healthyTasks: state === "missing" ? 0 : null, ignoredHistoricalTasks: null });
  if (observation.status !== "owned") return empty(observation.status === "absent" ? "missing" : observation.status === "foreign" ? "mismatch" : "unavailable");
  const matches = (value: { readonly plan: string | null; readonly action: string | null; readonly effect: string | null }) => known.some((item) => item.plan === value.plan && item.action === value.action && item.effect === value.effect);
  const current = observation.tasks.filter((task) => task.desired === "running");
  if (observation.tombstone || observation.replicas !== 1 || observation.endpoint !== "vip" || !matches(observation) || current.some((task) => task.incarnation !== incarnation || !matches(task))) return empty("mismatch");
  const healthy = current.filter((task) => task.state === "running" && task.health === "healthy");
  const state = healthy.length > 0 ? "available" : current.length === 0 ? "missing" : current.some((task) => task.health === "unhealthy" || ["failed", "rejected", "shutdown"].includes(task.state)) ? "unhealthy" :
    current.some((task) => task.state === "running" && (task.health === "unknown" || task.health === "absent")) ? "unavailable" : "starting";
  return Object.freeze({ name, state, currentTasks: current.length, healthyTasks: healthy.length, ignoredHistoricalTasks: observation.tasks.length - current.length });
};

/** Read-only owner projection. Current desired tasks determine service availability; old failures remain diagnostics. */
export const deploymentHealth = async (app: string, input: unknown, ports: Ports) => {
  const parsed = parseLifecycleEnvelope(input); if (!parsed.ok) throw new Error("runtime health lacks lifecycle ownership");
  const envelope = parsed.value; const registration = verifiedRegistration(app, envelope); const runtime = envelope.registrationReceipt?.runtime;
  if (runtime === undefined) throw new Error("runtime health lacks verified runtime");
  const state = envelope.http; const latest = state?.requests.at(-1); const reference = state?.active?.plan ?? latest?.plan;
  const services = runtime !== "swarm" || reference === undefined ? Object.freeze([]) : await (async () => {
    const content = await ports.read(reference); const plan = parseApplicationPlan(JSON.parse(content));
    if (createHash("sha256").update(content).digest("hex") !== reference || !plan.ok || JSON.stringify(plan.value.registration) !== JSON.stringify(registration) || state === undefined) throw new Error("runtime health plan integrity failed");
    return Object.freeze(await Promise.all(Object.keys(plan.value.services).toSorted().map(async (name) => {
      const observation = await ports.observe({ app, service: name, incarnation: registration.incarnation }).catch(() => Object.freeze({ status: "unavailable" as const }));
      return summarize(name, registration.incarnation, observation, identities(state));
    })));
  })();
  const result = parseDeploymentHealth({ version: 1, app, incarnation: registration.incarnation, runtime, scope: "runtime-services", observedAt: ports.now(),
    state: runtime !== "swarm" ? "unsupported" : services.length === 0 ? "not-requested" : services.find((service) => service.state !== "available")?.state ?? "available", services });
  if (!result.ok) throw new Error(result.error); return result.value;
};
