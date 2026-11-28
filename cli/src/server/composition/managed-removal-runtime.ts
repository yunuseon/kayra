import { parseCheckContainerFence } from "../../contracts/check-container-fence.ts";
import type { CheckContainerFencePort } from "../../contracts/check-container-fence.ts";
import { jobPlanDigest, parseJobPlan } from "../../contracts/one-shot-job.ts";
import { parseJobCleanupPlan } from "../../contracts/job-cleanup.ts";
import type { JobCleanupPort } from "../../contracts/job-cleanup.ts";
import { parseManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import type { ManagedServiceAction, ManagedServiceScope, ManagedSwarmServicePort } from "../../contracts/managed-swarm-service.ts";
import type { ManagedRemovalEffectsPorts, ManagedRemovalInventory } from "../deployment/managed-removal-effects.ts";
import { typed } from "../../lib/typed.ts";

type Ports = Pick<ManagedRemovalEffectsPorts, "read" | "retain" | "now"> & {
  readonly authorize: (intent: ManagedRemovalInventory["intent"]) => Promise<boolean>;
  readonly native: {
    readonly services: Pick<ManagedSwarmServicePort, "observe" | "tombstone">;
    readonly jobs: JobCleanupPort;
    readonly containers: CheckContainerFencePort;
  };
};
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** The coordinator supplies only its authenticated teardown inventory. The platform independently grants cleanup of this registration. */
export const managedRemovalRuntime = (inventory: ManagedRemovalInventory, ports: Ports) => {
  const { intent, blocked } = inventory;
  const { app, incarnation, dataOwner } = intent.owner;
  const scope = (value: ManagedServiceScope) => value.app === app && value.incarnation === incarnation && value.dataOwner === dataOwner ?
    inventory.services.find((entry) => entry.name === value.service) : undefined;
  const cleanupService = (input: ManagedServiceAction) => {
    const checked = parseManagedServiceAction(input);
    if (!checked.ok) return undefined;
    const value = checked.value;
    const entry = scope(value);
    if (entry?.digest !== value.plan || (value.effect !== "remove" && value.effect !== "scrub") ||
      !new RegExp(`^${intent.action}:${value.effect}:[1-8]$`).test(value.action)) return undefined;
    return entry;
  };
  const timely = (deadline: number, ceiling: number) => {
    const at = ports.now();
    return Number.isSafeInteger(at) && at >= intent.createdAt && deadline > at && deadline - at <= ceiling;
  };
  const allowed = () => ports.authorize(intent).catch(() => false);
  const mayWriteService = async (value: ManagedServiceAction) =>
    cleanupService(value) !== undefined && timely(value.deadline, 90_000) && await allowed() && timely(value.deadline, 90_000);
  const selectJob = (input: Parameters<JobCleanupPort["observe"]>[0]) => {
    const checked = parseJobPlan(input);
    if (!checked.ok || blocked === null || checked.value.scope.app !== app || checked.value.scope.incarnation !== incarnation ||
      checked.value.scope.run !== blocked.state.operation.run) return undefined;
    const digest = jobPlanDigest(checked.value);
    return inventory.jobs.includes(digest) ? Object.freeze({ job: checked.value, digest }) : undefined;
  };

  return typed<ManagedRemovalEffectsPorts>(Object.freeze({
    read: ports.read, retain: ports.retain, now: ports.now,
    authorize: (requested, action) => !same(requested, intent) ? Promise.resolve(false) : action === null ? allowed() : mayWriteService(action),
    services: typed<ManagedRemovalEffectsPorts["services"]>({
      observe: async (value) => {
        if (scope(value) === undefined) return Object.freeze({ status: "foreign" });
        return await allowed() ? await ports.native.services.observe(value) : Object.freeze({ status: "unavailable" });
      },
      tombstone: async (value, expected, image) => {
        if (cleanupService(value)?.plan.image !== image || !await mayWriteService(value)) return "refused";
        return ports.native.services.tombstone(value, expected, image);
      },
    }),
    jobs: typed<JobCleanupPort>({
      observe: async (input) => {
        const selected = selectJob(input);
        if (selected === undefined) return { status: "foreign" };
        return await allowed() ? ports.native.jobs.observe(selected.job) : { status: "unavailable" };
      },
      fence: async (input, authority, container) => {
        const selected = selectJob(input);
        const checked = parseJobCleanupPlan(authority);
        if (selected === undefined || !checked.ok || checked.value.action !== intent.request || checked.value.job !== selected.digest ||
          checked.value.createdAt < intent.createdAt || ports.now() < checked.value.createdAt ||
          !timely(checked.value.deadline, 30_000) || !await allowed() || !timely(checked.value.deadline, 30_000)) return "refused";
        return ports.native.jobs.fence(selected.job, checked.value, container);
      },
    }),
    containers: typed<CheckContainerFencePort>({
      observe: async (input) => {
        const checked = parseCheckContainerFence(input);
        if (!checked.ok || cleanupService(checked.value.barrier) === undefined ||
          !inventory.checks.some((target) => same(target, checked.value.target))) return { status: "foreign" };
        return await allowed() ? ports.native.containers.observe(checked.value) : { status: "unavailable" };
      },
    }),
  }));
};
