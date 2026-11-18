import type { BuildPorts } from "../../contracts/build-artifact.ts";
import { parseDeploymentHealth } from "../../contracts/deployment-health.ts";
import type { DeploymentHealth } from "../../contracts/deployment-health.ts";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import type { ManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import type { ManagedWorkloadPort } from "../../contracts/managed-workloads.ts";
import type { ServiceObservation, ServiceVersion } from "../../contracts/swarm-service.ts";
import { managedDeploymentEvidence } from "./managed-deployment-evidence.ts";
import { managedReleaseBaselines } from "./managed-release.ts";

type Reference = { readonly application: ManagedApplicationPlan; readonly action: ManagedServiceAction; readonly native: ServiceVersion | null };
type Ports = Pick<BuildPorts, "read" | "now"> & { readonly services: Pick<ManagedWorkloadPort, "observe" | "observeDesired"> };
const sameTask = (reference: Reference, task: { readonly incarnation: string; readonly action: string | null; readonly plan: string | null; readonly effect: string | null }) =>
  reference.action.incarnation === task.incarnation && reference.action.action === task.action && reference.action.plan === task.plan && reference.action.effect === task.effect;
const empty = (name: string, state: DeploymentHealth["services"][number]["state"]) => Object.freeze({ name, state, currentTasks: state === "missing" ? 0 : null, healthyTasks: state === "missing" ? 0 : null, ignoredHistoricalTasks: null });
const summarize = (name: string, observation: ServiceObservation, references: readonly Reference[]) => {
  if (observation.status !== "owned") return empty(name, observation.status === "absent" ? "missing" : observation.status === "foreign" ? "mismatch" : "unavailable");
  const current = observation.tasks.filter((task) => task.desired === "running");
  if (observation.tombstone) return empty(name, "missing");
  if (observation.replicas !== 1 || observation.endpoint !== "vip" || observation.specMatches !== true ||
    !references.some((value) => value.action.plan === observation.taskPlan && value.action.effect === observation.taskEffect && (value.native === null || value.native.id === observation.id && value.native.version <= observation.version)) ||
    current.some((task) => !references.some((value) => sameTask(value, task) && (value.native === null || value.native.id === observation.id && value.native.version <= observation.version)))) return empty(name, "mismatch");
  if (["paused", "rollback_paused"].includes(observation.update ?? "")) return empty(name, "unhealthy");
  if (!observation.containersConverged) return empty(name, "unavailable");
  const healthy = current.filter((task) => task.state === "running" && task.health === "healthy");
  const state = healthy.length > 0 ? "available" : current.length === 0 ? "missing" : current.some((task) => task.health === "unhealthy" || ["failed", "rejected", "shutdown"].includes(task.state)) ? "unhealthy" :
    current.some((task) => task.state === "running" && ["unknown", "absent"].includes(task.health)) ? "unavailable" : "starting";
  return Object.freeze({ name, state, currentTasks: current.length, healthyTasks: healthy.length, ignoredHistoricalTasks: observation.tasks.length - current.length });
};

/** Fresh, read-only native availability; release certification and routed readiness are deliberately separate observations. */
export const managedDeploymentHealth = async (input: unknown, sourceInput: unknown, ports: Ports) => {
  const evidence = await managedDeploymentEvidence(input, sourceInput, ports); const root = evidence.state; const source = evidence.source; const active = evidence.active?.release ?? null;
  const certified = (release: typeof active) => release === null ? Object.freeze([]) : Object.freeze(managedReleaseBaselines(release).map((value) => Object.freeze({ application: release.source.application, action: value.action, native: value.native })));
  const operation = root.operation;
  const references: readonly Reference[] = Object.freeze([...certified(active), ...certified(source.previous),
    ...(operation.preparation?.nodes ?? []).flatMap((node) => node.execution === null ? Object.freeze([]) : Object.freeze([Object.freeze({ application: source.candidate, action: node.execution.action, native: node.execution.verified?.native ?? node.execution.expected })])),
    ...(operation.consumers?.nodes ?? []).flatMap((node) => node.execution === null ? Object.freeze([]) : Object.freeze([Object.freeze({ application: source.candidate, action: node.execution.action, native: node.execution.verified?.native ?? node.execution.expected })])),
    ...(operation.recovery?.nodes ?? []).flatMap((node) => source.previous === null ? Object.freeze([]) : Object.freeze((node.child?.attempts ?? []).map((attempt) => Object.freeze({ application: source.previous?.source.application ?? source.candidate, action: attempt.action, native: attempt.verified?.native ?? attempt.expected })))),
  ]);
  const names = operation.outcome !== null ? Object.keys(active?.source.application.services ?? {}) : [...new Set([...Object.keys(source.candidate.services), ...Object.keys(source.previous?.source.application.services ?? {})])];
  const services = Object.freeze(await Promise.all(names.toSorted().map(async (name) => {
    const scope = { app: root.owner.app, incarnation: root.owner.incarnation, dataOwner: root.owner.dataOwner, service: name };
    const observed = await ports.services.observe(scope).catch(() => Object.freeze({ status: "unavailable" as const }));
    if (observed.status !== "owned" || observed.tombstone) return summarize(name, observed, references);
    const selected = references.find((value) => value.action.service === name && value.action.plan === observed.taskPlan && value.action.effect === observed.taskEffect && (value.native === null || value.native.id === observed.id && value.native.version <= observed.version));
    const spec = selected?.application.services[name];
    if (selected === undefined || spec === undefined) return empty(name, "mismatch");
    const refreshed = await ports.services.observeDesired(selected.action, spec, selected.application).catch(() => Object.freeze({ status: "unavailable" as const }));
    return summarize(name, refreshed, references.filter((value) => value.action.service === name));
  })));
  const parsed = parseDeploymentHealth({ version: 1, app: root.owner.app, incarnation: root.owner.incarnation, runtime: "swarm", scope: "runtime-services", observedAt: ports.now(),
    state: services.length === 0 ? "not-requested" : services.find((value) => value.state !== "available")?.state ?? "available", services });
  if (!parsed.ok) throw new Error(parsed.error); return parsed.value;
};
