import { createHash } from "node:crypto";
import { parseApplicationPlan } from "../../contracts/application-plan.ts";
import { serviceEffectAction } from "../../contracts/swarm-service.ts";
import type { ServiceAction, ServiceEffect, ServiceObservation } from "../../contracts/swarm-service.ts";
import type { HttpExecutionIndex, HttpExecutionPorts } from "./http-execution-ports.ts";
import type { HttpOperation } from "./http-state.ts";
import { clearedHttp, convergedHttp, fencedHttpEffects } from "./http-convergence.ts";
import { resourceHostReady } from "./resource-book.ts";

export const recoverHttp = async (index: HttpExecutionIndex, ports: HttpExecutionPorts, app: string, operation: HttpOperation) => {
  const clock = ports.now();
  if (!Number.isSafeInteger(clock) || clock < Math.max(operation.deadline - 90_000, operation.cancelRequestedAt ?? 0)) return "clock-unavailable";
  const deadline = operation.recoveryDeadline;
  if (deadline === null || ports.now() >= deadline) { await index.holdHttp(app, operation.ticket, "deadline"); return "held"; }
  const scope = { app, service: operation.service, incarnation: operation.action.split(":")[0] ?? "" };
  const load = async (digest: string, commit: string) => {
    const bytes = await ports.read(digest);
    const input: unknown = JSON.parse(bytes);
    const parsed = parseApplicationPlan(input);
    if (createHash("sha256").update(bytes).digest("hex") !== digest || !parsed.ok || parsed.value.app !== app || parsed.value.commit !== commit || parsed.value.registration.incarnation !== scope.incarnation) throw new Error("HTTP recovery plan integrity failed");
    return parsed.value;
  };
  const observed = await ports.native.observe(scope);
  if (observed.status === "foreign") { await index.holdHttp(app, operation.ticket, "runtime"); return "held"; }
  if (observed.status === "unavailable") return "runtime-unavailable";
  const write = async (effect: Exclude<ServiceEffect, "apply">, native: ServiceObservation) => {
    if (native.status !== "owned" && (native.status !== "absent" || effect !== "remove")) return "runtime-unavailable";
    const expected = native.status === "owned" ? { id: native.id, version: native.version } : null;
    const prior = operation.steps.filter((step) => step.effect === effect).at(-1);
    // Superseded CAS authority is immutable. A fresh observation gets a new recorded identity.
    const replay = prior !== undefined && JSON.stringify(prior.expected) === JSON.stringify(expected);
    const attempt = replay ? prior.attempt : (prior?.attempt ?? 0) + 1;
    if (attempt > 8 || (prior?.expected !== undefined && prior.expected !== null && expected !== null && (prior.expected.id !== expected.id || prior.expected.version > expected.version))) {
      await index.holdHttp(app, operation.ticket, "runtime"); return "held";
    }
    const digest = effect === "restore" ? operation.previous?.plan : operation.plan;
    if (digest === undefined) throw new Error("HTTP recovery has no previous plan");
    const step = { effect, attempt, expected, deadline, plan: digest };
    await index.recordHttpRecoveryIntent(app, operation.ticket, step, native, ports.now());
    if (!(await index.authorizeHttpNative(app, operation.ticket, step))) return "fenced";
    const action: ServiceAction = { ...scope, action: serviceEffectAction(operation.action, effect, attempt), effect, plan: digest, deadline };
    if (effect === "fence") return expected === null ? "runtime-unavailable" : ports.native.fence(action, expected);
    if (effect === "restore" && operation.previous !== null) {
      const plan = await load(digest, operation.previous.commit);
      if (!resourceHostReady(plan.host, await ports.observeHost(plan.host))) return "runtime-unavailable";
      return ports.native.apply(action, expected, plan, await ports.materialize(plan), ports.routing(plan));
    }
    const plan = await load(operation.plan, operation.commit);
    const image = plan.services[operation.service]?.image;
    if (image === undefined) throw new Error("HTTP recovery image is unavailable");
    return ports.native.tombstone(action, expected, image);
  };
  if (operation.previous === null) {
    if (clearedHttp(observed) && fencedHttpEffects(operation.steps, observed)) {
      await index.finishHttpRecovery(app, operation.ticket, "removed-unverified", observed, null, ports.now());
      return (await index.httpOperation(app, operation.request))?.phase ?? "runtime-unavailable";
    }
    if (observed.status === "owned" && observed.retainedInputsCleared && observed.tombstone && fencedHttpEffects(operation.steps, observed)) return "recovering";
    return write(observed.status === "owned" && observed.tombstone ? "scrub" : "remove", observed);
  }
  if (observed.status !== "owned" || observed.id !== operation.previous.native.id) {
    await index.holdHttp(app, operation.ticket, "runtime"); return "held";
  }
  const previous = operation.previous;
  const restore = operation.steps.filter((step) => step.effect === "restore").at(-1);
  const previousAction: ServiceAction = { ...scope, action: previous.action, effect: previous.effect, plan: previous.plan, deadline };
  const restoreAction: ServiceAction = restore === undefined ? previousAction : { ...previousAction, action: serviceEffectAction(operation.action, "restore", restore.attempt), effect: "restore" };
  const plan = await load(previous.plan, previous.commit);
  const environment = await ports.materialize(plan); const routing = ports.routing(plan);
  // Accepted task templates are authoritative before their replacement task exists.
  const inspected = await ports.native.observeDesired(restoreAction, plan, environment, routing);
  const prior = restore !== undefined && inspected.status === "owned" && inspected.specMatches !== true
    ? await ports.native.observeDesired(previousAction, plan, environment, routing) : undefined;
  const selected = prior?.status === "owned" && prior.specMatches === true
    ? Object.freeze({ native: prior, action: previousAction, restoring: false })
    : Object.freeze({ native: inspected, action: restoreAction, restoring: restore !== undefined });
  const { native, action } = selected;
  if (convergedHttp(action, native)) {
    if (!fencedHttpEffects(operation.steps, native)) return write("fence", native);
    const routed = await ports.readiness.check(action, plan);
    if (routed.status !== "ready") return "recovering";
    await index.finishHttpRecovery(app, operation.ticket, selected.restoring ? "compensated" : native.status === "owned" && native.update === "rollback_completed" ? "automatic-rollback" : "previous-preserved", native, routed, ports.now());
    return (await index.httpOperation(app, operation.request))?.phase ?? "runtime-unavailable";
  }
  if (native.status !== "owned") return "runtime-unavailable";
  if (native.update === "rollback_started" || native.specMatches === true) return "recovering";
  return write("restore", native);
};
