import { parseManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import type { ManagedServicePlan } from "../../contracts/managed-service-plan.ts";
import { parseManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import type { ManagedServiceAction, ManagedSwarmServicePort } from "../../contracts/managed-swarm-service.ts";
import type { ManagedWorkloadPort } from "../../contracts/managed-workloads.ts";
import type { RuntimeInputsPort } from "../../contracts/service-inputs.ts";
import type { RecordedVolumeReceiptsPort } from "../../contracts/recorded-volume-receipts.ts";
import { matchManagedVolumeReceipts } from "../../contracts/managed-volume-evidence.ts";
import { managedSwarmRouting } from "../platform/managed-swarm-routing.ts";
import { typed } from "../../lib/typed.ts";
import type { ServiceVersion } from "../../contracts/swarm-service.ts";

// Admission and durable effect intent remain the coordinator's responsibility; this boundary materializes only independently authorized, scoped inputs.
type Inputs = {
  readonly environment: RuntimeInputsPort;
  readonly volumes: RecordedVolumeReceiptsPort;
  readonly allowed: (application: ManagedApplicationPlan, service: ManagedServicePlan) => Promise<boolean>;
};
const materializer = (ports: Inputs) => async (requested: ManagedServiceAction, spec: ManagedServicePlan, context: ManagedApplicationPlan) => {
  const application = parseManagedApplicationPlan(context); const action = parseManagedServiceAction(requested);
  if (!application.ok || !action.ok || action.value.effect !== "apply" && action.value.effect !== "restore") return undefined;
  const plan = application.value; const service = plan.services[action.value.service]; const owner = plan.infrastructure.ownership;
  if (service === undefined || managedServiceDigest(service) !== managedServiceDigest(spec) || action.value.plan !== managedServiceDigest(service) ||
    action.value.app !== owner.app || action.value.incarnation !== owner.incarnation || action.value.dataOwner !== owner.dataOwner || !(await ports.allowed(plan, service))) return undefined;
  const references = Object.freeze(service.mounts.filter((mount, index, all) => all.findIndex((value) => value.volume.allocation === mount.volume.allocation) === index).map((mount) => mount.volume));
  const [environment, receipts] = await Promise.all([ports.environment.materialize(service.inputs), references.length === 0 ? Promise.resolve(Object.freeze([])) : ports.volumes.read(references)]);
  if (!environment.ok || receipts === undefined || !matchManagedVolumeReceipts(service, receipts).ok || !(await ports.allowed(plan, service))) return undefined;
  return Object.freeze({ action: action.value, service, inputs: Object.freeze({ environment: environment.value, volumes: receipts, routing: managedSwarmRouting(plan, service.service) }) });
};

/** The health owner receives no native writer, admission or input-mutation capability. */
export const managedWorkloadObservations = (native: Readonly<Pick<ManagedSwarmServicePort, "observe" | "observeDesired">>, ports: Inputs) => {
  const prepare = materializer(ports);
  return typed<Readonly<Pick<ManagedWorkloadPort, "observe" | "observeDesired">>>(Object.freeze({
    observe: native.observe,
    observeDesired: async (action, service, context) => {
      try { const ready = await prepare(action, service, context); return ready === undefined ? { status: "unavailable" as const } : await native.observeDesired(ready.action, ready.service, ready.inputs); }
      catch { return { status: "unavailable" as const }; }
    },
  }));
};

/** Existing privileged-process composition. Private materialized values reach only the native adapter and never deployment records or reports. */
export const managedWorkloads = (native: ManagedSwarmServicePort, ports: Inputs) => {
  const prepare = materializer(ports);
  const write = async (action: ManagedServiceAction, expected: ServiceVersion | null, service: ManagedServicePlan, context: ManagedApplicationPlan, reactivate: boolean) => {
    try {
      const ready = await prepare(action, service, context); if (ready === undefined || reactivate && expected === null) return "refused" as const;
      return reactivate && expected !== null ? await native.reactivate(ready.action, expected, ready.service, ready.inputs) : await native.apply(ready.action, expected, ready.service, ready.inputs);
    } catch { return "refused" as const; }
  };
  return typed<ManagedWorkloadPort>(Object.freeze({ ...managedWorkloadObservations(native, ports),
    apply: (action, expected, service, context) => write(action, expected, service, context, false),
    reactivate: (action, expected, service, context) => write(action, expected, service, context, true),
    fence: native.fence, tombstone: native.tombstone,
  }));
};
