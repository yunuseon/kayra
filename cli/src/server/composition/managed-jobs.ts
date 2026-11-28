import { parseManagedExecutionContext } from "../../contracts/managed-execution-context.ts";
import type { ManagedExecutionContext } from "../../contracts/managed-execution-context.ts";
import { parseJobPlan } from "../../contracts/one-shot-job.ts";
import type { JobPlan, JobPort, JobWrite } from "../../contracts/one-shot-job.ts";
import type { RuntimeInputsPort } from "../../contracts/service-inputs.ts";
import { managedMigrationInputs } from "../deployment/managed-migration-inputs.ts";
import { typed } from "../../lib/typed.ts";

type Effect = "observe" | "create" | "start" | "fence";
type Port = Readonly<Pick<JobPort, "observe" | "start" | "fence">> & { readonly create: (job: JobPlan) => Promise<JobWrite> };
type Inputs = { readonly environment: RuntimeInputsPort; readonly now: () => number;
  /** Current platform authority. Cleanup/observation may remain allowed after creation/start grants are revoked. Parent admission is independently enforced by the coordinator. */
  readonly allowed: (context: ManagedExecutionContext, job: JobPlan, effect: Effect) => Promise<boolean>;
};

/** Construct before entering the application writer. Materialized values reach only native Create, never coordinator state or error output. */
export const managedJobs = (input: ManagedExecutionContext, native: JobPort, ports: Inputs) => {
  const context = parseManagedExecutionContext(input); if (!context.ok) throw new Error("managed job context unavailable"); const owner = context.value;
  const select = (input: JobPlan) => {
    const checked = parseJobPlan(input); if (!checked.ok) return undefined; const job = checked.value;
    if (job.scope.run !== owner.run || job.deadline > owner.deadline || job.deadline <= owner.createdAt) return undefined;
    const reference = managedMigrationInputs(owner.application, job); if (!reference.ok) return undefined;
    return Object.freeze({ job, reference: reference.value });
  };
  const bounded = async <T>(deadline: number, call: () => Promise<T>) => {
    const remaining = Math.min(10_000, deadline - ports.now()); if (!Number.isSafeInteger(deadline) || !Number.isFinite(remaining) || remaining <= 0) return undefined;
    const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, remaining);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), timeout.promise]); } finally { clearTimeout(timer); }
  };
  const permitted = async (job: JobPlan, effect: Effect) => {
    const timely = () => { const at = ports.now(); return Number.isSafeInteger(at) && at >= owner.createdAt && (!(effect === "create" || effect === "start") || at < Math.min(owner.deadline, job.startDeadline ?? job.deadline)); };
    return timely() && await bounded(effect === "create" || effect === "start" ? job.startDeadline ?? job.deadline : ports.now() + 10_000, () => ports.allowed(owner, job, effect)) === true && timely();
  };
  return typed<Port>(Object.freeze({
    observe: async (input) => { try { const selected = select(input); return selected === undefined || !await permitted(selected.job, "observe") ? { status: "unavailable" as const } : await native.observe(selected.job); } catch { return { status: "unavailable" as const }; } },
    create: async (input) => {
      try { const selected = select(input); if (selected === undefined || !await permitted(selected.job, "create")) return "refused";
        const environment = await bounded(selected.job.startDeadline ?? selected.job.deadline, () => ports.environment.materialize(selected.reference)); if (environment?.ok !== true || !await permitted(selected.job, "create")) return "refused";
        try { return await native.create(selected.job, environment.value); } catch { return "uncertain"; }
      } catch { return "refused"; }
    },
    start: async (input, id, deadline) => { try { const selected = select(input); return selected === undefined || !await permitted(selected.job, "start") ? "refused" : await native.start(selected.job, id, deadline); } catch { return "uncertain"; } },
    fence: async (input, id, deadline) => { try { const selected = select(input); return selected === undefined || !await permitted(selected.job, "fence") ? "refused" : await native.fence(selected.job, id, deadline); } catch { return "uncertain"; } },
  }));
};
