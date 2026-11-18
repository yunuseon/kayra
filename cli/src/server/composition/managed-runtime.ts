import { parseManagedExecutionContext } from "../../contracts/managed-execution-context.ts";
import type { ManagedExecutionContext } from "../../contracts/managed-execution-context.ts";
import type { ManagedRuntimeAuthorityPort, ManagedRuntimePermission } from "../../contracts/managed-runtime-authority.ts";
import { managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import type { ManagedServiceAction, ManagedServiceScope, ManagedSwarmServicePort } from "../../contracts/managed-swarm-service.ts";
import { parseManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import type { ManagedWorkloadPort } from "../../contracts/managed-workloads.ts";
import type { OwnedVolumePort } from "../../contracts/owned-volume.ts";
import type { RecordedVolumeReceiptsPort } from "../../contracts/recorded-volume-receipts.ts";
import type { RuntimeInputsPort } from "../../contracts/service-inputs.ts";
import type { JobPort } from "../../contracts/one-shot-job.ts";
import type { ManagedChecksPort } from "../../contracts/container-check.ts";
import type { ManagedRoutedReadinessPort } from "../../contracts/routed-readiness.ts";
import type { HostObserver } from "../../contracts/resource-authority.ts";
import type { ManagedDeploymentReadPort } from "../../contracts/managed-deployment-read.ts";
import type { IndexedManagedRuntime } from "../deployment/indexed-managed-lifecycle.ts";
import type { ManagedLifecycleSource } from "../deployment/managed-lifecycle-source.ts";
import type { ManagedLifecycleEffect } from "../deployment/managed-lifecycle-owner.ts";
import { managedLifecycleDescription, managedLifecycleSourceDigest } from "../deployment/managed-lifecycle-source.ts";
import { managedJobs } from "./managed-jobs.ts";
import { managedWorkloads } from "./managed-workloads.ts";
import { typed } from "../../lib/typed.ts";
import { err } from "../../lib/result.ts";

type Ports = ManagedDeploymentReadPort & HostObserver & { readonly retain: (bytes: string) => Promise<string>;
  readonly environment: RuntimeInputsPort; readonly receipts: RecordedVolumeReceiptsPort; readonly authority: ManagedRuntimeAuthorityPort;
  readonly native: { readonly services: ManagedSwarmServicePort; readonly volumes: Readonly<Pick<OwnedVolumePort, "observe" | "create">>; readonly jobs: JobPort; readonly checks: ManagedChecksPort; readonly readiness: ManagedRoutedReadinessPort };
};

/** Trusted wiring in the existing privileged process. No fleet parsing, SQL, shell execution, journal effects or runtime fallback. */
export const managedRuntime = (input: ManagedExecutionContext, ports: Ports) => {
  const checked = parseManagedExecutionContext(input); if (!checked.ok) throw new Error("managed runtime context unavailable"); const context = checked.value;
  const plans = Object.freeze([context.application, ...(context.previous === null ? [] : [context.previous])]); const known = (plan: ManagedApplicationPlan) => plans.some((value) => managedApplicationDigest(value) === managedApplicationDigest(plan));
  const owned = (scope: ManagedServiceScope) => scope.app === context.owner.app && scope.incarnation === context.owner.incarnation && scope.dataOwner === context.owner.dataOwner && plans.some((plan) => plan.services[scope.service] !== undefined);
  const write = (action: ManagedServiceAction) => { const parsed = parseManagedServiceAction(action); return parsed.ok && owned(parsed.value) && parsed.value.action.split(":").slice(0, 2).join(":") === context.action; };
  const bounded = async <T>(call: () => Promise<T>) => { const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, 10000);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), timeout.promise]); } finally { clearTimeout(timer); }
  };
  const allowed = (permission: ManagedRuntimePermission) => bounded(() => ports.authority.allowed(context, permission)).then((value) => value === true);
  const environment = typed<RuntimeInputsPort>({ materialize: async (reference) => await bounded(() => ports.environment.materialize(reference)) ?? err("managed runtime inputs unavailable") });
  const workloads = (receipts: RecordedVolumeReceiptsPort) => {
    const base = managedWorkloads(ports.native.services, { environment, volumes: receipts, allowed: (application, service) => known(application) ? allowed({ kind: "service-inputs", application, service }) : Promise.resolve(false) });
    return typed<ManagedWorkloadPort>(Object.freeze({ ...base,
      observe: (scope) => owned(scope) ? base.observe(scope) : Promise.resolve({ status: "foreign" }),
      apply: (action, expected, service, application) => write(action) && known(application) ? base.apply(action, expected, service, application) : Promise.resolve("refused"),
      reactivate: (action, expected, service, application) => { const call = base.reactivate; return write(action) && known(application) && call !== undefined ? call(action, expected, service, application) : Promise.resolve("refused"); },
      fence: async (action, expected) => write(action) && await allowed({ kind: "service", purpose: "cleanup", action }) ? ports.native.services.fence(action, expected) : "refused",
      tombstone: async (action, expected, image) => write(action) && plans.some((plan) => plan.services[action.service]?.image === image) && await allowed({ kind: "service", purpose: "cleanup", action }) ? ports.native.services.tombstone(action, expected, image) : "refused",
    }));
  };
  const matches = (source: ManagedLifecycleSource) => {
    const description = managedLifecycleDescription(source);
    return managedLifecycleSourceDigest(source) === context.source && source.run === context.run && source.action === context.action && source.createdAt === context.createdAt && description.admissionDeadline === context.admissionDeadline && description.deadline === context.deadline &&
      (source.version === 2) === context.allocationRequired && managedApplicationDigest(source.candidate) === managedApplicationDigest(context.application) && (source.previous === null ? context.previous === null : context.previous !== null && managedApplicationDigest(source.previous.source.application) === managedApplicationDigest(context.previous));
  };
  const permission = (effect: ManagedLifecycleEffect) => {
    if (effect.kind === "accepted-recovery") return typed<ManagedRuntimePermission>({ kind: "accepted-recovery" });
    if (effect.kind === "service") return typed<ManagedRuntimePermission>({ ...effect, purpose: effect.purpose ?? "deployment" });
    if (effect.kind === "migration") return typed<ManagedRuntimePermission>({ kind: "migration", effect: effect.effect });
    return typed<ManagedRuntimePermission>(effect);
  };
  return typed<IndexedManagedRuntime>(Object.freeze({ read: ports.read, retain: ports.retain, now: ports.now, observeHost: ports.observeHost,
    services: workloads(ports.receipts), managedData: { native: ports.native.volumes, workloads },
    jobs: managedJobs(context, ports.native.jobs, { now: ports.now, environment, allowed: (_, job, effect) => allowed({ kind: "job", job, effect }) }),
    checks: ports.native.checks,
    readiness: { check: (action, application) => known(application) && owned(action) ? ports.native.readiness.check(action, application) : Promise.resolve({ app: action.app, incarnation: action.incarnation, service: action.service, action: action.action, plan: action.plan, checkedAt: ports.now(), status: "unavailable" }) },
    requestAllowed: (source) => matches(source) ? allowed({ kind: "admission" }) : Promise.resolve(false),
    authorize: (source, effect) => matches(source) ? allowed(permission(effect)) : Promise.resolve(false),
  }));
};
