/* Owns live per-app reconciliation promises, not runtime effects. */
import { createHash } from "node:crypto";
import type { ApplicationPlan } from "../../contracts/http-plan.ts";
import { parseApplicationPlan } from "../../contracts/application-plan.ts";
import type { HostObserver } from "../../contracts/resource-authority.ts";
import type { RoutedReadinessPort } from "../../contracts/routed-readiness.ts";
import type { ServiceAction, SwarmServicePort } from "../../contracts/swarm-service.ts";
import { convergedHttp } from "./http-convergence.ts";
import type { openLifecycleAppIndex } from "./lifecycle-app-index.ts";
import { terminalHttp } from "./http-state.ts";

type Index = Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "httpOperation" | "admitHttpRollout" | "recordHttpNativeIntent" | "authorizeHttpNative" | "markHttpDispatched" | "promoteHttpRollout" | "reconcileHttpResources">>;
type Ports = HostObserver & {
  readonly now: () => number;
  readonly read: (digest: string) => Promise<string>;
  readonly materialize: (plan: ApplicationPlan) => Promise<Readonly<Record<string, string>>>;
  readonly routing: (plan: ApplicationPlan) => Readonly<Record<string, string>>;
  readonly native: SwarmServicePort;
  readonly readiness: RoutedReadinessPort;
};

/** Internal single-tick integration. Failure compensation and public control are not enabled here. */
export const httpExecution = (index: Index, ports: Ports) => {
  const running = new Map<string, { readonly request: string; readonly result: Promise<string> }>();
  const execute = async (app: string, request: string) => {
    const clock = ports.now();
    if (!Number.isSafeInteger(clock) || clock < 0) return "clock-unavailable";
    const operation = await index.httpOperation(app, request);
    if (operation === undefined) throw new Error("HTTP operation is unavailable");
    if (terminalHttp(operation.phase)) {
      if (operation.phase === "succeeded") await index.reconcileHttpResources(app, operation.ticket);
      return operation.phase;
    }
    if (operation.phase === "prepared") {
      await index.admitHttpRollout(app, operation.ticket, ports);
      return "admitted";
    }
    if (operation.phase === "held" || operation.phase === "recovering") return operation.phase;
    const content = await ports.read(operation.plan);
    const input: unknown = JSON.parse(content);
    const parsed = parseApplicationPlan(input);
    if (createHash("sha256").update(content).digest("hex") !== operation.plan || !parsed.ok || parsed.value.app !== app || parsed.value.commit !== operation.commit || parsed.value.registration.incarnation !== operation.action.split(":")[0]) throw new Error("HTTP execution plan integrity failed");
    const plan = parsed.value;
    const scope = { app, service: operation.service, incarnation: plan.registration.incarnation };
    const action: ServiceAction = { ...scope, action: operation.action, plan: operation.plan, deadline: operation.deadline, effect: "apply" };
    const environment = await ports.materialize(plan);
    const routing = ports.routing(plan);
    const observed = await ports.native.observeDesired(action, plan, environment, routing);
    const recorded = operation.steps[0];
    if (ports.now() >= operation.deadline) return "deadline-exceeded";
    if (recorded !== undefined && convergedHttp(action, observed)) {
      const routed = await ports.readiness.check(action, plan);
      if (routed.status === "ready" && ports.now() <= operation.deadline) {
        await index.promoteHttpRollout(app, operation.ticket, observed, routed, ports.now());
        return "succeeded";
      }
      return "verifying";
    }
    if (operation.phase === "admitted") {
      if (observed.status !== "absent" && observed.status !== "owned") return "runtime-unavailable";
      if (observed.status === "owned" && (operation.previous === null ? !observed.tombstone || !observed.retainedInputsCleared || observed.replicas !== 0 : observed.id !== operation.previous.native.id)) return "runtime-conflict";
      const previous = operation.previous;
      const baseline = previous === null ? observed : await (async () => {
        const bytes = await ports.read(previous.plan);
        const input: unknown = JSON.parse(bytes);
        const checked = parseApplicationPlan(input);
        if (createHash("sha256").update(bytes).digest("hex") !== previous.plan || !checked.ok || checked.value.app !== app || checked.value.commit !== previous.commit || checked.value.registration.incarnation !== scope.incarnation) throw new Error("HTTP previous plan integrity failed");
        return ports.native.observeDesired({ ...action, action: previous.action, plan: previous.plan }, checked.value,
          await ports.materialize(checked.value), ports.routing(checked.value));
      })();
      if (previous !== null && (baseline.status !== "owned" || baseline.id !== previous.native.id || baseline.specMatches !== true || baseline.tombstone || baseline.replicas !== 1)) return "runtime-conflict";
      const step = { effect: "apply" as const, plan: operation.plan, deadline: operation.deadline,
        expected: baseline.status === "owned" ? { id: baseline.id, version: baseline.version } : null };
      if (operation.previous !== null && step.expected === null) return "runtime-conflict";
      await index.recordHttpNativeIntent(app, operation.ticket, step);
      return "applying";
    }
    if (recorded?.effect !== "apply" || !(await index.authorizeHttpNative(app, operation.ticket, recorded))) return "fenced";
    // A replay observes first and can use only the exact recorded CAS authority.
    // Existing desired specs need observation, not another native write.
    if (observed.status === "owned" && observed.specMatches === true) { await index.markHttpDispatched(app, operation.ticket); return "verifying"; }
    const replayable = recorded.expected === null ? observed.status === "absent" : observed.status === "owned" && observed.id === recorded.expected.id && observed.version === recorded.expected.version;
    if (!replayable) return "runtime-conflict";
    const result = await ports.native.apply(action, recorded.expected, plan, environment, routing);
    await index.markHttpDispatched(app, operation.ticket);
    return result === "acknowledged" ? "verifying" : "write-uncertain";
  };
  const tick = (app: string, request: string): Promise<string> => {
    const existing = running.get(app);
    if (existing !== undefined) return existing.request === request ? existing.result : existing.result.then(() => tick(app, request), () => tick(app, request));
    const result = execute(app, request);
    // eslint-disable-next-line functional/immutable-data -- owns live reconciliation promises
    running.set(app, Object.freeze({ request, result }));
    void result.then(() => {
      // eslint-disable-next-line functional/immutable-data -- release completed reconciliation
      running.delete(app);
    }, () => {
      // eslint-disable-next-line functional/immutable-data -- release failed reconciliation
      running.delete(app);
    });
    return result;
  };
  return Object.freeze({ tick });
};
