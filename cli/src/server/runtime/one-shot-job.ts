/* Adapter-owned Docker request data and observations never enter the journal. */
/* eslint-disable functional/prefer-immutable-types */
import { jobName, jobPlanDigest, parseJobPlan } from "../../contracts/one-shot-job.ts";
import type { JobObservation, JobPlan, JobPort, JobWrite } from "../../contracts/one-shot-job.ts";
import { parseJobCleanupPlan } from "../../contracts/job-cleanup.ts";
import type { JobCleanupPort } from "../../contracts/job-cleanup.ts";
import { typed } from "../../lib/typed.ts";
import { dockerApi } from "./docker-api.ts";
import { migrationProbeOutput } from "./migration-probe-output.ts";

const object = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: unknown, key: string): unknown => object(value) ? value[key] : undefined;
const containerId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const empty = (value: unknown) => value === undefined || value === null || Array.isArray(value) && value.length === 0 || object(value) && Object.keys(value).length === 0;
const labels = (plan: JobPlan, barrier: boolean) => ({ "com.kayra.app": plan.scope.app, "com.kayra.incarnation": plan.scope.incarnation,
  "com.kayra.job": jobName(plan.scope), "com.kayra.plan": jobPlanDigest(plan), "com.kayra.barrier": String(barrier),
});
const owned = (value: unknown, plan: JobPlan) => {
  const actual = field(field(value, "Config"), "Labels");
  const barrier = field(actual, "com.kayra.barrier");
  return field(value, "Name") === "/" + jobName(plan.scope) && (barrier === "true" || barrier === "false") &&
    Object.entries(labels(plan, barrier === "true")).every(([key, value]) => field(actual, key) === value) && field(field(value, "Config"), "Image") === plan.image;
};
const render = (plan: JobPlan, environment: Readonly<Record<string, string>>, barrier: boolean) => {
  const names = Object.keys(plan.environment);
  if (!barrier && (Object.keys(environment).length !== names.length || names.some((key) => typeof environment[key] !== "string" || environment[key].includes("\0") || environment[key].length > 65536 ||
    (plan.environment[key]?.kind === "literal" && plan.environment[key].value !== environment[key])))) throw new Error("invalid materialized job inputs");
  return {
    Image: plan.image, Labels: labels(plan, barrier),
    Cmd: barrier ? ["/kayra-never-start"] : plan.command,
    ...(barrier ? { Entrypoint: ["/kayra-never-start"] } : plan.entrypoint === null ? {} : { Entrypoint: plan.entrypoint }),
    Env: barrier ? [] : [...names.toSorted().map((key) => `${key}=${environment[key] ?? ""}`), `KAYRA_OPERATION_ID=${plan.scope.run}:${plan.scope.step}`],
    StopTimeout: plan.stopGraceSeconds, Tty: false, Healthcheck: { Test: ["NONE"] },
    HostConfig: { AutoRemove: false, RestartPolicy: { Name: "no", MaximumRetryCount: 0 }, Memory: plan.resources.memoryBytes, NanoCpus: plan.resources.nanoCpus,
      NetworkMode: barrier || plan.networks.length === 0 ? "none" : plan.networks[0], Privileged: false, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"] },
    NetworkingConfig: { EndpointsConfig: barrier ? {} : Object.fromEntries(plan.networks.map((network) => [network, {}])) },
  };
};

/** No start retry, automatic restart, raw logs, secret observation or coordinator policy. */
const jobAdapter = (api: ReturnType<typeof dockerApi>, now: () => number) => {
  const get = async (plan: JobPlan, identity = jobName(plan.scope)) => {
    const response = await api.request("GET", `/containers/${encodeURIComponent(identity)}/json`);
    if (response.status === 404) return { status: "absent" as const };
    if (response.status !== 200 || !object(response.value)) return { status: "unavailable" as const };
    if (!owned(response.value, plan) || !containerId(field(response.value, "Id"))) return { status: "foreign" as const };
    return { status: "owned" as const, value: response.value };
  };
  const observe = async (input: JobPlan) => {
    const parsed = parseJobPlan(input);
    if (!parsed.ok) return typed<JobObservation>({ status: "foreign" });
    try {
      const plan = parsed.value; const result = await get(plan);
      if (result.status !== "owned") return typed<JobObservation>(result);
      const id = field(result.value, "Id"); if (!containerId(id)) return typed<JobObservation>({ status: "unavailable" });
      const status = field(field(result.value, "State"), "Status");
      const code = field(field(result.value, "State"), "ExitCode");
      const exitCode = typeof code === "number" && Number.isSafeInteger(code) && (status === "exited" || status === "dead") ? code : null;
      const state = status === "created" ? "created" : status === "running" ? "running" : status === "exited" ? exitCode === 0 ? "succeeded" : "failed" : status === "dead" ? "failed" : "unknown";
      const finished = field(field(result.value, "State"), "FinishedAt");
      const timestamp = typeof finished === "string" && finished.length <= 64 ? Date.parse(finished) : NaN;
      const finishedAt = exitCode !== null && Number.isSafeInteger(timestamp) && timestamp > 0 ? timestamp : null;
      const barrier = field(field(field(result.value, "Config"), "Labels"), "com.kayra.barrier") === "true";
      const probe = async () => {
        if (plan.scope.purpose !== "probe" || state !== "succeeded" || barrier) return null;
        try {
          const logs = await api.request("GET", `/containers/${id}/logs?stdout=true&stderr=false&timestamps=false`, undefined, { response: "bytes", maximumBytes: 1024 });
          return logs.status === 200 && Buffer.isBuffer(logs.value) ? migrationProbeOutput(logs.value) : "unknown";
        } catch { return "unknown"; }
      };
      return typed<JobObservation>({ status: "owned", id, barrier, plan: jobPlanDigest(plan), state, exitCode, probe: await probe(), finishedAt });
    } catch { return typed<JobObservation>({ status: "unavailable" }); }
  };
  const remaining = (plan: JobPlan, deadline = plan.deadline, ceiling = plan.deadline + 30_000) => {
    if (!Number.isSafeInteger(deadline) || deadline <= 0 || deadline > ceiling) return undefined;
    const clock = now(); const left = deadline - clock;
    return Number.isSafeInteger(clock) && clock > 0 && left > 0 ? Math.min(left, 10_000) : undefined;
  };
  const imageReady = async (plan: JobPlan, deadline: number, ceiling: number) => {
    const inspect = () => api.request("GET", `/images/${encodeURIComponent(plan.image)}/json`);
    const available = (value: unknown) => {
      const digests = field(value, "RepoDigests");
      return Array.isArray(digests) && digests.some((digest: unknown) => digest === plan.image);
    };
    const current = await inspect();
    if (current.status === 200) return available(current.value);
    if (current.status !== 404) return false;
    const timeoutMs = remaining(plan, deadline, ceiling); if (timeoutMs === undefined) return false;
    const [repository, digest] = plan.image.split("@");
    if (repository === undefined || digest === undefined) return false;
    // Progress is not success evidence. Independently inspect the immutable reference afterward.
    await api.request("POST", `/images/create?fromImage=${encodeURIComponent(repository)}&tag=${encodeURIComponent(digest)}`, undefined,
      { response: "bytes", timeoutMs, maximumBytes: 4 * 1024 * 1024 });
    const pulled = await inspect(); return pulled.status === 200 && available(pulled.value);
  };
  const create = async (input: JobPlan, environment: Readonly<Record<string, string>>, barrier = false, deadline = input.startDeadline ?? input.deadline, ceiling = input.deadline + 30_000) => {
    const parsed = parseJobPlan(input); if (!parsed.ok) return typed<JobWrite>("refused");
    const plan = parsed.value; const timeoutMs = remaining(plan, deadline, ceiling); if (timeoutMs === undefined) return typed<JobWrite>("refused");
    try {
      const body = render(plan, environment, barrier);
      const existing = await get(plan);
      if (existing.status !== "absent") return typed<JobWrite>(existing.status === "unavailable" ? "uncertain" : "conflict");
      if (!(await imageReady(plan, deadline, ceiling))) return typed<JobWrite>("uncertain");
      const left = remaining(plan, deadline, ceiling); if (left === undefined) return typed<JobWrite>("refused");
      const response = await api.request("POST", `/containers/create?name=${encodeURIComponent(jobName(plan.scope))}`, body, { timeoutMs: left });
      return typed<JobWrite>(response.status === 201 && containerId(field(response.value, "Id")) ? "acknowledged" : response.status === 409 ? "conflict" : "uncertain");
    } catch { return typed<JobWrite>("uncertain"); }
  };
  const fence = async (input: JobPlan, id: string | null, deadline: number, ceiling = input.deadline + 30_000) => {
    const parsed = parseJobPlan(input); if (!parsed.ok || (id !== null && !containerId(id))) return "refused";
    const plan = parsed.value; const timeoutMs = remaining(plan, deadline, ceiling); if (timeoutMs === undefined) return "refused";
    try {
      const current = await get(plan);
      if (current.status === "foreign" || current.status === "unavailable") return "refused";
      if (current.status === "owned") {
        if (field(field(field(current.value, "Config"), "Labels"), "com.kayra.barrier") === "true") return field(field(current.value, "State"), "Status") === "created" ? "acknowledged" : "refused";
        if (id === null || field(current.value, "Id") !== id) return "conflict";
        const left = remaining(plan, deadline, ceiling); if (left === undefined) return "refused";
        const removed = await api.request("DELETE", `/containers/${id}?force=true&v=true`, undefined, { timeoutMs: left });
        if (removed.status !== 204 && removed.status !== 404) return "uncertain";
      }
      return await create(plan, {}, true, deadline, ceiling);
    } catch { return "uncertain"; }
  };
  const execution = typed<JobPort>(Object.freeze({ observe, create: (plan, environment) => create(plan, environment),
    start: async (input, id, executionDeadline = input.deadline) => {
      const parsed = parseJobPlan(input); if (!parsed.ok || !containerId(id)) return "refused";
      const plan = parsed.value;
      if (!Number.isSafeInteger(executionDeadline) || executionDeadline <= 0 || executionDeadline > plan.deadline) return "refused";
      const timeoutMs = remaining(plan, Math.min(executionDeadline, plan.startDeadline ?? plan.deadline)); if (timeoutMs === undefined) return "refused";
      try {
        const current = await get(plan, id);
        if (current.status !== "owned" || field(current.value, "Id") !== id || field(field(field(current.value, "Config"), "Labels"), "com.kayra.barrier") !== "false" ||
          field(field(current.value, "State"), "Status") !== "created") return "conflict";
        const host = field(current.value, "HostConfig"); const config = field(current.value, "Config");
        if (field(field(host, "RestartPolicy"), "Name") !== "no" || field(host, "Memory") !== plan.resources.memoryBytes || field(host, "NanoCpus") !== plan.resources.nanoCpus ||
          !empty(field(host, "Binds")) || !empty(field(current.value, "Mounts")) || !empty(field(config, "Volumes")) || field(config, "Tty") === true ||
          JSON.stringify(field(field(config, "Healthcheck"), "Test")) !== JSON.stringify(["NONE"]) ||
          JSON.stringify(field(config, "Cmd")) !== JSON.stringify(plan.command) ||
          (plan.entrypoint !== null && JSON.stringify(field(config, "Entrypoint")) !== JSON.stringify(plan.entrypoint))) return "refused";
        const left = remaining(plan, Math.min(executionDeadline, plan.startDeadline ?? plan.deadline)); if (left === undefined) return "refused";
        const response = await api.request("POST", `/containers/${id}/start`, undefined, { timeoutMs: left });
        return response.status === 204 ? "acknowledged" : response.status === 404 || response.status === 304 ? "conflict" : "uncertain";
      } catch { return "uncertain"; }
    },
    fence,

  }));
  const cleanup = typed<JobCleanupPort>(Object.freeze({ observe, fence: async (job, input, container) => {
    const authority = parseJobCleanupPlan(input); const plan = parseJobPlan(job); const clock = now();
    if (!authority.ok || !plan.ok || authority.value.job !== jobPlanDigest(plan.value) || !Number.isSafeInteger(clock) || clock < authority.value.createdAt || clock >= authority.value.deadline) return "refused";
    return fence(plan.value, container, authority.value.deadline, authority.value.deadline);
  } }));
  return Object.freeze({ execution, cleanup });
};

export const oneShotJob = (api = dockerApi(), now: () => number = Date.now) => jobAdapter(api, now).execution;
export const oneShotCleanup = (api = dockerApi(), now: () => number = Date.now) => jobAdapter(api, now).cleanup;
