import type { RolloutRequest } from "./rollout-request.ts";
import { settledMigrationPrefix } from "./migration-prefix.ts";
import { rolloutCleanupRecord } from "./rollout-cleanup.ts";
import type { MigrationCleanupRequest, MigrationCleanupIdentity } from "../../contracts/migration-cleanup.ts";
/* The index owns a live journal lock and serializes its filesystem operations. */
/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/type-declaration-immutability */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parseApplicationPlan } from "../../contracts/application-plan.ts";
import { parseRolloutPlan, rolloutMigrationDescription, rolloutWorkloadDigest } from "../../contracts/rollout-plan.ts";
import type { RolloutPlanPort } from "../../contracts/rollout-plan.ts";
import type { rolloutPreparation } from "./rollout-preparation.ts";
import type { resolveRolloutMigration } from "./rollout-resolution.ts";
import type { MigrationResolutionActor, MigrationResolutionRequest } from "../../contracts/migration-resolution.ts";
import type { HostObserver } from "../../contracts/resource-authority.ts";
import { parseResourceBook, reserveResources, resourceHostReady, settleResources } from "./resource-book.ts";
import type { RoutedReadiness } from "../../contracts/routed-readiness.ts";
import { httpReleasePlan, terminalHttp } from "./http-state.ts";
import { httpAdmissionDeadline } from "./http-resource-binding.ts";
import { hasHttpRecoveryPeak, httpRecoveryPeak } from "./http-admission.ts";
import { deploymentStatus } from "./deployment-status.ts";
import { lifecycleActionId } from "./lifecycle-fence.ts";
import type { ServiceObservation } from "../../contracts/swarm-service.ts";
import { parseHttpNativeStep } from "./http-state.ts";
import type { HttpRecovery, HttpNativeStep } from "./http-state.ts";
import type { ResourceCharge } from "./resource-book.ts";
import type { HttpPlanPort } from "../../contracts/http-plan.ts";
import type { Runtime } from "../../contracts/rollout.ts";
import { names } from "../../lib/names.ts";
import { parseRegistrationGeneration, type RegistrationGeneration } from "../../contracts/registration-generation.ts";
import { typed } from "../../lib/typed.ts";
import type { BuildImagePins, BuildPorts } from "../../contracts/build-artifact.ts";
import { verifiedRegistration } from "./verified-registration.ts";
import { openJournal } from "./journal.ts";
import { openLifecycleEnvelopeStore, type RegistrationObserver } from "./lifecycle-envelope-store.ts";

const appName = z.string().regex(names.app.pattern);
const entry = z.object({
  app: appName,
  incarnation: z.uuid(),
  phase: z.enum(["initializing", "ready"]),
}).strict();
const build = z.object({
  id: z.string().regex(/^[0-9a-f]{64}$/),
  registration: z.object({ version: z.literal(1), app: appName, incarnation: z.uuid(), actionId: z.string(), registrationGeneration: z.uuid() }).strict(),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  deadline: z.number().int().positive(),
  artifact: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
}).strict();
const schema = z.object({ version: z.literal(1), resources: z.unknown().default(null), builds: z.array(build).default([]), apps: z.array(entry) }).strict().refine(({ apps, builds }) =>
  new Set(apps.map((app) => app.app)).size === apps.length &&
  new Set(apps.map((app) => app.incarnation)).size === apps.length &&
  new Set(builds.map((item) => item.id)).size === builds.length &&
  builds.every((item) => parseRegistrationGeneration(item.registration).ok &&
    apps.some((app) => app.app === item.registration.app && app.incarnation === item.registration.incarnation) &&
    item.id === createHash("sha256").update(JSON.stringify({ registration: item.registration, commit: item.commit })).digest("hex")),
);
type IndexEntry = z.infer<typeof entry>;
type EnvelopeStore = ReturnType<typeof openLifecycleEnvelopeStore>;

const missing = (error: unknown) => error && typeof error === "object" && "code" in error && error.code === "ENOENT";
const stat = (path: string) => lstat(path).catch((error: unknown) => {
  if (missing(error)) return undefined;
  throw error;
});
const requireDirectory = async (path: string) => {
  if (!(await stat(path))?.isDirectory()) throw new Error("lifecycle directory is missing or invalid; intervention required");
};
const syncDirectory = async (path: string) => {
  const dir = await open(path, "r");
  try { await dir.sync(); }
  finally { await dir.close(); }
};

const prepareBeforeDeadline = async (ports: BuildPorts, registration: RegistrationGeneration, commit: string, deadline: number, runtime: Runtime) => {
  const controller = new AbortController();
  const expired = Promise.withResolvers<string>();
  const timer = setTimeout(() => {
    controller.abort();
    expired.reject(new Error("build deadline expired"));
  }, Math.max(1, Math.min(45 * 60_000, deadline - ports.now())));
  try { return await Promise.race([ports.prepare(registration, commit, deadline, controller.signal, runtime), expired.promise]); }
  finally { clearTimeout(timer); }
};

const openIndex = async (directory: string, mode: "initialize" | "existing", observer?: RegistrationObserver, journals = openJournal) => {
  await requireDirectory(directory);
  const journal = await journals(directory, mode);
  const readIndex = async () => {
    const checked = schema.safeParse(await journal.read());
    if (!checked.success) throw new Error("lifecycle app index is invalid; intervention required");
    const resources = checked.data.resources === null ? null : parseResourceBook(checked.data.resources);
    if (resources !== null && !resources.ok) throw new Error("lifecycle resource accounting is invalid; intervention required");
    if (resources?.value.charges.some((charge) => !checked.data.apps.some((app) => app.app === charge.app && app.incarnation === charge.incarnation))) throw new Error("resource ownership disagrees with app index");
    return { ...checked.data, resources: resources === null ? null : resources.value };
  };
  try {
    if (mode === "initialize") await journal.write({ version: 1, apps: [] });
    else await readIndex();
  } catch (error) {
    await journal.close();
    throw error;
  }

  let pendingIndex = Promise.resolve();
  const pendingApps = new Map<string, Promise<void>>();
  let closed = false;
  const serialIndex = <T>(task: () => Promise<T>) => {
    const result = pendingIndex.then(task);
    pendingIndex = result.then(() => undefined, () => undefined);
    return result;
  };
  const serialApp = <T>(app: string, task: () => Promise<T>) => {
    if (closed) return Promise.reject(new Error("lifecycle app index is closed"));
    if (!appName.safeParse(app).success) return Promise.reject(new Error("invalid lifecycle app name"));
    const result = (pendingApps.get(app) ?? Promise.resolve()).then(task);
    const settled = result.then(() => undefined, () => undefined);
    // eslint-disable-next-line functional/immutable-data -- track the tail of each live app queue
    pendingApps.set(app, settled);
    void settled.then(() => {
      // eslint-disable-next-line functional/immutable-data -- release idle app queues
      if (pendingApps.get(app) === settled) pendingApps.delete(app);
    });
    return result;
  };
  const appDirectory = (app: string) => join(directory, createHash("sha256").update(app, "utf8").digest("hex"));
  const withEnvelope = async <T>(path: string, ownership: IndexEntry, use: (store: EnvelopeStore) => T | Promise<T>) => {
    await requireDirectory(path);
    const appJournal = await journals(path, ownership.phase === "ready" ? "existing" : "initialize");
    try {
      const store = openLifecycleEnvelopeStore(appJournal, observer);
      const envelope = await store.read();
      if (envelope === undefined) {
        if (ownership.phase === "ready") throw new Error("indexed lifecycle envelope is missing; intervention required");
        await store.initialize(ownership.app, ownership.incarnation);
      } else if (envelope.tickets.app !== ownership.app || envelope.tickets.incarnation !== ownership.incarnation ||
        (ownership.phase === "initializing" && (envelope.created || envelope.tickets.nextTicket !== 1))) {
        throw new Error("lifecycle envelope disagrees with app index; intervention required");
      }
      return await use(store);
    } finally {
      await appJournal.close();
    }
  };
  const useReady = <T>(app: string, use: (store: EnvelopeStore) => Promise<T>) => serialApp(app, async () => {
    const index = await readIndex();
    const ownership = index.apps.find((item) => item.app === app);
    if (ownership?.phase !== "ready") throw new Error("lifecycle app is not ready in the index");
    return withEnvelope(appDirectory(app), ownership, use);
  });

  const reconcileHttpResources = async (app: string, store: EnvelopeStore, ticket: string) => {
    const envelope = await store.read();
    const operation = envelope?.http?.requests.find((item) => item.ticket === ticket);
    if (operation === undefined || envelope === undefined || (operation.phase === "succeeded" ? operation.verified === null : (operation.phase !== "failed" && operation.phase !== "cancelled") || operation.recovery === null)) throw new Error("HTTP resource settlement requires a verified outcome");
    const result = operation.phase === "succeeded" ? "target" as const : operation.previous === null ? "absent" as const : "previous" as const;
    await serialIndex(async () => {
      const state = await readIndex();
      const charge = state.resources?.charges.find((item) => item.app === app);
      if (charge?.incarnation !== envelope.tickets.incarnation || charge.sequence !== Number(operation.action.split(":")[1])) return;
      if (charge.target.plan !== httpReleasePlan(operation)) throw new Error("HTTP resource settlement plan mismatch");
      const settled = settleResources(state.resources, app, charge.incarnation, charge.sequence, result);
      if (!settled.ok) throw new Error(settled.error);
      await journal.write({ ...state, resources: settled.value });
    });
  };
  const reconcileRolloutResources = async (app: string, store: EnvelopeStore, ticket: string) => {
    const envelope = await store.read(); const operation = [...(envelope?.rollouts ?? []), ...(envelope?.rollout === undefined ? [] : [envelope.rollout])].find((item) => item.ticket === ticket);
    const completion = operation?.completion;
    if (operation === undefined || completion === undefined || envelope === undefined) throw new Error("rollout resource settlement requires durable completion proof");
    await serialIndex(async () => {
      const state = await readIndex(); const charge = state.resources?.charges.find((item) => item.app === app);
      if (charge?.incarnation !== envelope.tickets.incarnation || charge.sequence !== Number(operation.action.split(":")[1])) return;
      if (charge.target.plan !== operation.preparation.plan || charge.deadline !== operation.admissionDeadline || (charge.previous?.plan ?? null) !== completion.previous) throw new Error("rollout resource settlement proof conflicts");
      const settled = settleResources(state.resources, app, charge.incarnation, charge.sequence, completion.previous === null ? "absent" : "previous");
      if (!settled.ok) throw new Error(settled.error); await journal.write({ ...state, resources: settled.value });
    });
  };

  const cancelPreparation = async (app: string, store: EnvelopeStore, operation: RolloutRequest, clock: Pick<BuildPorts, "now">) => {
    if (operation.completion !== undefined) { await reconcileRolloutResources(app, store, operation.ticket); return operation; }
    const now = clock.now();
    const completed = operation.preparation.phase === "prepared" && operation.preparation.sequence === null
      ? await store.completeUnstartedRollout(operation.ticket, "cancelled", now)
      : await (async () => { await store.cancelRolloutPreparation(operation.preparation.run, now); return store.completeCancelledPreparation(operation.preparation.run, clock.now()); })();
    if (completed.completion !== undefined) await reconcileRolloutResources(app, store, operation.ticket);
    return completed;
  };

  return {
    prepareApp: (app: string) => serialApp(app, () => serialIndex(async () => {
      const index = await readIndex();
      const path = appDirectory(app);
      const existing = index.apps.find((item) => item.app === app);
      if (existing?.phase === "ready") {
        await withEnvelope(path, existing, () => undefined);
        return existing.incarnation;
      }
      const ownership = existing ?? entry.parse({ app, incarnation: randomUUID(), phase: "initializing" });
      if (existing === undefined) {
        if (await stat(path)) throw new Error("unindexed lifecycle directory exists; intervention required");
        if (index.apps.some((item) => item.incarnation === ownership.incarnation)) throw new Error("lifecycle incarnation collision");
        await journal.write({ ...index, apps: [...index.apps, ownership] });
      }
      if (await stat(path) === undefined) await mkdir(path, { mode: 0o700 });
      await syncDirectory(directory);
      await withEnvelope(path, ownership, () => undefined);
      await journal.write({ ...index, apps: [...index.apps.filter((item) => item.app !== app), { ...ownership, phase: "ready" }] });
      return ownership.incarnation;
    })),
    verifiedRegistration: (app: string) => useReady(app, async (store) => {
      return verifiedRegistration(app, await store.read());
    }),
    registrationPolicy: (app: string) => useReady(app, async (store) => {
      const envelope = await store.read();
      const metadata = verifiedRegistration(app, envelope);
      const runtime = envelope?.registrationAllocation?.runtime;
      if (runtime === undefined) throw new Error("verified registration runtime is unavailable");
      return Object.freeze({ metadata, runtime });
    }),
    prepareBuild: (app: string, commit: string, ports: BuildPorts) => useReady(app, async (store) => {
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("build requires a full commit id");
      const envelope = await store.read();
      const registration = verifiedRegistration(app, envelope);
      const runtime = envelope?.registrationAllocation?.runtime;
      if (runtime === undefined) throw new Error("verified registration runtime is unavailable");
      const id = createHash("sha256").update(JSON.stringify({ registration, commit })).digest("hex");
      const intent = await serialIndex(async () => {
        const state = await readIndex();
        const existing = state.builds.find((item) => item.id === id);
        if (existing !== undefined) return existing;
        const requested = build.parse({ id, registration, commit, deadline: ports.now() + 45 * 60_000 });
        await journal.write({ ...state, builds: [...state.builds, requested] });
        return requested;
      });
      if (intent.artifact !== null) {
        ports.images(await ports.read(intent.artifact), registration, commit);
        return Object.freeze({ id, artifact: intent.artifact, registration, commit, deadline: intent.deadline });
      }
      if (ports.now() >= intent.deadline) throw new Error("build deadline expired; a new operation requires intervention");
      const content = await prepareBeforeDeadline(ports, registration, commit, intent.deadline, runtime);
      if (ports.now() >= intent.deadline) throw new Error("build deadline expired before artifact retention");
      const artifact = await ports.retain(content);
      if (!/^[0-9a-f]{64}$/.test(artifact)) throw new Error("invalid retained artifact identity");
      if (ports.now() >= intent.deadline) throw new Error("build deadline expired before receipt persistence");
      await serialIndex(async () => {
        const state = await readIndex();
        await journal.write({ ...state, builds: state.builds.map((item) => item.id === id ? { ...item, artifact } : item) });
      });
      return Object.freeze({ id, artifact, registration, commit, deadline: intent.deadline });
    }),
    previewPlan: (app: string, commit: string, ports: HttpPlanPort) => useReady(app, async (store) => {
      if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("plan preview requires a full commit id");
      const envelope = await store.read();
      const registration = verifiedRegistration(app, envelope);
      const runtime = envelope?.registrationAllocation?.runtime;
      if (runtime === undefined) throw new Error("verified registration runtime is unavailable");
      const id = createHash("sha256").update(JSON.stringify({ registration, commit })).digest("hex");
      const state = await readIndex();
      const artifact = state.builds.find((build) => build.id === id)?.artifact;
      if (artifact === undefined || artifact === null) throw new Error("no retained build for this commit; prepare its artifact first");
      return ports.preview(registration, runtime, commit, artifact);
    }),
    prepareRollout: (app: string, request: string, commit: string, ports: RolloutPlanPort & Pick<BuildPorts, "now" | "retain">) => useReady(app, async (store) => {
      if (!z.uuid().safeParse(request).success || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("complete rollout requires a request identity and full commit");
      const envelope = await store.read(); const registration = verifiedRegistration(app, envelope);
      if (envelope?.registrationReceipt?.runtime !== "swarm") throw new Error("complete rollout requires the persisted Swarm runtime");
      const existing = [...(envelope.rollouts ?? []), ...(envelope.rollout === undefined ? [] : [envelope.rollout])].find((item) => item.preparation.run === request);
      if (existing !== undefined) {
        if (existing.commit !== commit) throw new Error("complete rollout request identity has conflicting commit"); return existing;
      }
      if (envelope.http?.requests.some((item) => item.request === request)) throw new Error("request identity already belongs to legacy HTTP work");
      if (envelope.fence?.lifecycle.phase !== "registered" || envelope.fence.lifecycle.active !== null) throw new Error("complete rollout lifecycle is busy or fenced");
      if (envelope.rollout?.completion !== undefined) await reconcileRolloutResources(app, store, envelope.rollout.ticket);
      const previous = envelope.http?.requests.at(-1); if (previous !== undefined) await reconcileHttpResources(app, store, previous.ticket);
      const state = await readIndex(); const id = createHash("sha256").update(JSON.stringify({ registration, commit })).digest("hex");
      const artifact = state.builds.find((build) => build.id === id)?.artifact;
      if (artifact === undefined || artifact === null) throw new Error("complete rollout requires a retained build");
      const checked = parseRolloutPlan(await ports.preview(registration, "swarm", commit, artifact)); if (!checked.ok) throw new Error(checked.error);
      const plan = checked.value;
      if (JSON.stringify(plan.workload.registration) !== JSON.stringify(registration) || plan.workload.commit !== commit || plan.workload.artifact !== artifact) throw new Error("complete rollout plan ownership mismatch");
      const source = plan.rollout.migrations.length === 0 ? [] : (() => {
        const sequence = rolloutMigrationDescription(plan, request); if (!sequence.ok) throw new Error(sequence.error); return [JSON.stringify(sequence.value)];
      })();
      const contents = [JSON.stringify(plan), JSON.stringify(plan.workload), ...source];
      for (const content of contents) if (await ports.retain(content) !== createHash("sha256").update(content).digest("hex")) throw new Error("complete rollout artifact retention mismatch");
      return store.prepareRollout(plan, request, ports.now());
    }),
    rolloutOperation: (app: string, request: string) => useReady(app, async (store) => {
      const state = await store.read(); return [...(state?.rollouts ?? []), ...(state?.rollout === undefined ? [] : [state.rollout])].find((item) => item.preparation.run === request);
    }),
    /** The control transport authenticates the operator; requests cannot choose that identity. */
    cancelManagedRollout: (app: string, request: string, clock: Pick<BuildPorts, "now">) => useReady(app, async (store) => {
      const envelope = await store.read(); const operation = [...(envelope?.rollouts ?? []), ...(envelope?.rollout === undefined ? [] : [envelope.rollout])].find((item) => item.preparation.run === request);
      if (operation === undefined) throw new Error("complete rollout request is unavailable");
      const http = envelope?.http?.requests.find((item) => item.request === request);
      if (http !== undefined) {
        const cancelled = terminalHttp(http.phase) ? http : await store.cancelHttp(http.ticket, clock.now());
        const after = await store.read(); const root = [...(after?.rollouts ?? []), ...(after?.rollout === undefined ? [] : [after.rollout])].find((item) => item.preparation.run === request);
        if (root === undefined || cancelled === undefined) throw new Error("complete rollout cancellation receipt disappeared");
        return Object.freeze({ operation: root, http: cancelled });
      }
      if (operation !== envelope?.rollout && operation.completion === undefined) throw new Error("preparation is no longer current");
      return Object.freeze({ operation: await cancelPreparation(app, store, operation, clock), http: null });
    }),
    cancelRolloutPreparation: (app: string, request: string, clock: Pick<BuildPorts, "now">) => useReady(app, async (store) => {
      const envelope = await store.read(); const operation = [...(envelope?.rollouts ?? []), ...(envelope?.rollout === undefined ? [] : [envelope.rollout])].find((item) => item.preparation.run === request);
      if (operation === undefined || operation !== envelope?.rollout && operation.completion === undefined) throw new Error("preparation is unavailable or no longer current");
      return cancelPreparation(app, store, operation, clock);
    }),
    expireRolloutHandoff: (app: string, request: string, now: number) => useReady(app, async (store) => {
      const envelope = await store.read(); const operation = [...(envelope?.rollouts ?? []), ...(envelope?.rollout === undefined ? [] : [envelope.rollout])].find((item) => item.preparation.run === request);
      if (operation === undefined || operation !== envelope?.rollout && operation.completion === undefined) throw new Error("expired handoff is unavailable or no longer current");
      const completed = operation.completion === undefined ? await store.expireRolloutHandoff(request, now) : operation;
      await reconcileRolloutResources(app, store, completed.ticket); return completed;
    }),
    completeCancelledPreparation: (app: string, request: string, now: number) => useReady(app, async (store) => {
      const operation = await store.completeCancelledPreparation(request, now);
      if (operation.completion !== undefined) await reconcileRolloutResources(app, store, operation.ticket);
      return operation;
    }),
    requestMigrationCleanup: (app: string, request: MigrationCleanupRequest, actor: MigrationResolutionActor, ports: Parameters<EnvelopeStore["requestMigrationCleanup"]>[2]) => useReady(app, async (store) => {
      const envelope = await store.read(); const operation = [...(envelope?.rollouts ?? []), ...(envelope?.rollout === undefined ? [] : [envelope.rollout])].find((item) => item.preparation.run === request.run);
      if (request.app !== app || operation === undefined || envelope === undefined) throw new Error("migration cleanup rollout scope is unavailable");
      if (rolloutCleanupRecord(operation, request) === undefined) {
        const charge = (await serialIndex(readIndex)).resources?.charges.find((item) => item.app === app);
        if (operation !== envelope.rollout || !operation.admitted || charge?.result !== "pending" || charge.incarnation !== envelope.tickets.incarnation ||
          charge.sequence !== Number(operation.action.split(":")[1]) || charge.target.plan !== operation.preparation.plan || charge.deadline !== operation.admissionDeadline ||
          !hasHttpRecoveryPeak(charge)) throw new Error("migration cleanup has no matching durable admission");
      }
      return store.requestMigrationCleanup(request, actor, ports);
    }),
    tickMigrationCleanup: (app: string, identity: MigrationCleanupIdentity, ports: Parameters<EnvelopeStore["tickMigrationCleanup"]>[1]) => useReady(app, async (store) => {
      const envelope = await store.read(); const operation = envelope?.rollout;
      const charge = (await serialIndex(readIndex)).resources?.charges.find((item) => item.app === app);
      if (identity.app !== app || operation?.preparation.run !== identity.run || !operation.admitted || charge?.result !== "pending" || charge.incarnation !== envelope?.tickets.incarnation ||
        charge.sequence !== Number(operation.action.split(":")[1]) || charge.target.plan !== operation.preparation.plan || charge.deadline !== operation.admissionDeadline ||
        !hasHttpRecoveryPeak(charge)) throw new Error("migration cleanup lacks durable admission");
      return store.tickMigrationCleanup(identity, ports);
    }),
    migrationCleanupAudit: (app: string, run: string, step: string) => useReady(app, (store) => store.migrationCleanupAudit(run, step)),
    resolveMigration: (app: string, request: MigrationResolutionRequest, actor: MigrationResolutionActor, ports: Parameters<typeof resolveRolloutMigration>[4]) => useReady(app, async (store) => {
      const envelope = await store.read();
      const operation = [...(envelope?.rollouts ?? []), ...(envelope?.rollout === undefined ? [] : [envelope.rollout])].find((item) => item.preparation.run === request.run);
      if (request.app !== app || operation === undefined || envelope === undefined) throw new Error("migration resolution rollout scope is unavailable");
      const existing = operation.preparation.sequence?.steps.find((step) => step.id === request.step)?.resolution;
      if (existing === undefined) {
        const charge = (await serialIndex(readIndex)).resources?.charges.find((item) => item.app === app);
        if (operation !== envelope.rollout || !operation.admitted || charge?.result !== "pending" || charge.incarnation !== envelope.tickets.incarnation ||
          charge.sequence !== Number(operation.action.split(":")[1]) || charge.target.plan !== operation.preparation.plan || charge.deadline !== operation.admissionDeadline ||
          !hasHttpRecoveryPeak(charge)) throw new Error("migration resolution has no matching durable admission");
      }
      const receipt = await store.resolveMigration(request, actor, ports);
      const after = await store.read();
      if (after?.rollout?.preparation.run === request.run && after.rollout.completion !== undefined) await reconcileRolloutResources(app, store, operation.ticket);
      return receipt;
    }),
    migrationAudit: (app: string, run: string, step: string) => useReady(app, async (store) => {
      const state = await store.read(); const operation = [...(state?.rollouts ?? []), ...(state?.rollout === undefined ? [] : [state.rollout])].find((item) => item.preparation.run === run);
      return operation?.preparation.sequence?.steps.find((item) => item.id === step)?.resolution;
    }),
    cancelUnstartedRollout: (app: string, request: string, now: number) => useReady(app, async (store) => {
      const envelope = await store.read(); const operation = [...(envelope?.rollouts ?? []), ...(envelope?.rollout === undefined ? [] : [envelope.rollout])].find((item) => item.preparation.run === request);
      if (operation === undefined) throw new Error("complete rollout request is unavailable");
      if (operation.completion !== undefined) { await reconcileRolloutResources(app, store, operation.ticket); return operation; }
      const completed = await store.completeUnstartedRollout(operation.ticket, "cancelled", now);
      await reconcileRolloutResources(app, store, operation.ticket); return completed;
    }),
    expireRolloutAdmission: (app: string, request: string, now: number) => useReady(app, async (store) => {
      const envelope = await store.read(); const operation = envelope?.rollout;
      if (envelope === undefined || operation?.preparation.run !== request || operation.admitted || operation.completion !== undefined || !Number.isSafeInteger(now) || now < operation.admissionDeadline) throw new Error("complete rollout admission has not expired or is already settled");
      const charge = (await serialIndex(readIndex)).resources?.charges.find((item) => item.app === app);
      if (charge?.incarnation === envelope.tickets.incarnation && charge.sequence === Number(operation.action.split(":")[1])) {
        if (charge.result !== "pending" || charge.target.plan !== operation.preparation.plan || charge.deadline !== operation.admissionDeadline) throw new Error("expired admission resource evidence conflicts");
        return "reserved";
      }
      await store.completeUnstartedRollout(operation.ticket, "deadline", now);
      await reconcileRolloutResources(app, store, operation.ticket); return "failed";
    }),
    reconcileRolloutResources: (app: string, ticket: string) => useReady(app, (store) => reconcileRolloutResources(app, store, ticket)),
    admitRollout: (app: string, ticket: string, ports: HostObserver & Pick<BuildPorts, "read" | "now">) => useReady(app, async (store) => {
      const envelope = await store.read(); const registration = verifiedRegistration(app, envelope); const operation = envelope?.rollout;
      if (operation?.ticket !== ticket || envelope?.fence?.lifecycle.phase !== "registered" || envelope.fence.lifecycle.active === null ||
        lifecycleActionId(envelope.fence, envelope.fence.lifecycle.active.sequence) !== operation.action) throw new Error("complete rollout no longer owns lifecycle");
      const content = await ports.read(operation.preparation.plan); const input: unknown = JSON.parse(content); const checked = parseRolloutPlan(input);
      if (createHash("sha256").update(content).digest("hex") !== operation.preparation.plan || !checked.ok ||
        JSON.stringify(checked.value.workload.registration) !== JSON.stringify(registration) || checked.value.workload.commit !== operation.commit ||
        rolloutWorkloadDigest(checked.value) !== operation.preparation.workload) throw new Error("complete rollout admission plan integrity failed");
      const plan = checked.value.workload;
      const amount = Object.values(plan.services).reduce((sum, service) => ({ cpu: sum.cpu + Math.ceil(service.resources.nanoCpus / 1_000_000), memory: sum.memory + service.resources.memoryBytes }), { cpu: 0, memory: 0 });
      const previous = envelope.http?.active ?? null;
      const previousAmount = previous === null ? null : await (async () => {
        const bytes = await ports.read(previous.plan); const input: unknown = JSON.parse(bytes); const checked = parseApplicationPlan(input);
        if (createHash("sha256").update(bytes).digest("hex") !== previous.plan || !checked.ok || JSON.stringify(checked.value.registration) !== JSON.stringify(registration) ||
          checked.value.commit !== previous.commit || JSON.stringify(checked.value.routes) !== JSON.stringify(plan.routes) ||
          JSON.stringify(Object.keys(checked.value.services)) !== JSON.stringify(Object.keys(plan.services))) throw new Error("complete rollout previous release or routing policy changed");
        return Object.values(checked.value.services).reduce((sum, service) => ({ cpu: sum.cpu + Math.ceil(service.resources.nanoCpus / 1_000_000), memory: sum.memory + service.resources.memoryBytes }), { cpu: 0, memory: 0 });
      })();
      const observation = await ports.observeHost(plan.host);
      if (!resourceHostReady(plan.host, observation)) throw new Error("current resource host observation required before complete rollout admission");
      await serialIndex(async () => {
        const state = await readIndex();
        const intent: ResourceCharge = { app, incarnation: registration.incarnation, sequence: Number(operation.action.split(":")[1]),
          previous: previous === null || previousAmount === null ? null : { plan: httpReleasePlan(previous), budget: previousAmount },
          target: { plan: operation.preparation.plan, budget: amount }, peak: httpRecoveryPeak(amount, previousAmount), deadline: operation.admissionDeadline, result: "pending" };
        const reserved = reserveResources(state.resources, plan.host, observation, intent, ports.now()); if (!reserved.ok) throw new Error(reserved.error);
        await journal.write({ ...state, resources: reserved.value });
      });
      return store.admitRollout(ticket);
    }),
    tickRolloutPreparation: (app: string, request: string, ports: Omit<Parameters<typeof rolloutPreparation>[1], "authorize"> & HostObserver) => useReady(app, async (store) => {
      const envelope = await store.read(); const operation = envelope?.rollout;
      if (operation?.preparation.run !== request || !operation.admitted || envelope?.fence?.lifecycle.phase !== "registered" || envelope.fence.lifecycle.active === null ||
        lifecycleActionId(envelope.fence, envelope.fence.lifecycle.active.sequence) !== operation.action) throw new Error("complete rollout lacks admitted lifecycle ownership");
      const authorized = async () => {
        const charge = (await serialIndex(readIndex)).resources?.charges.find((item) => item.app === app);
        return charge?.result === "pending" && charge.incarnation === envelope.tickets.incarnation && charge.sequence === Number(operation.action.split(":")[1]) &&
          charge.target.plan === operation.preparation.plan && charge.deadline === operation.admissionDeadline && hasHttpRecoveryPeak(charge);
      };
      if (!await authorized()) throw new Error("complete rollout has no matching durable admission");
      return store.tickRolloutPreparation(operation.ticket, { ...ports, authorize: async (state, plan, _job, effect) => state.run === request && state.plan === operation.preparation.plan &&
        state.workload === operation.preparation.workload && state.createdAt === operation.preparation.createdAt && state.deadline === operation.preparation.deadline &&
        (state.cancelRequestedAt === undefined || effect === "fence" || _job.scope.purpose === "probe") && await authorized() &&
        (effect === "fence" || resourceHostReady(plan.workload.host, await ports.observeHost(plan.workload.host))) });
    }),
    handoffRollout: (app: string, request: string, ports: Pick<BuildPorts, "read" | "now"> & HostObserver) => useReady(app, async (store) => {
      const envelope = await store.read(); const operation = envelope?.rollout;
      const existing = envelope?.http?.requests.find((item) => item.request === request && item.deployment !== undefined); if (existing !== undefined) return existing;
      if (operation?.preparation.run !== request || !operation.admitted || envelope?.fence?.lifecycle.phase !== "registered" || envelope.fence.lifecycle.active === null ||
        lifecycleActionId(envelope.fence, envelope.fence.lifecycle.active.sequence) !== operation.action) throw new Error("complete rollout lacks HTTP handoff ownership");
      const state = operation.preparation;
      if (state.phase !== "ready" || state.httpDeadline === null || state.cancelRequestedAt !== undefined) throw new Error("complete rollout migrations are not ready for HTTP");
      const bytes = await ports.read(state.plan); const input: unknown = JSON.parse(bytes); const checked = parseRolloutPlan(input);
      if (createHash("sha256").update(bytes).digest("hex") !== state.plan || !checked.ok || rolloutWorkloadDigest(checked.value) !== state.workload ||
        checked.value.workload.commit !== operation.commit || JSON.stringify(checked.value.workload.registration) !== JSON.stringify(verifiedRegistration(app, envelope))) throw new Error("complete rollout HTTP handoff plan integrity failed");
      const charge = (await readIndex()).resources?.charges.find((item) => item.app === app);
      if (charge?.result !== "pending" || charge.incarnation !== envelope.tickets.incarnation || charge.sequence !== Number(operation.action.split(":")[1]) ||
        charge.target.plan !== state.plan || charge.deadline !== operation.admissionDeadline || !hasHttpRecoveryPeak(charge)) throw new Error("HTTP handoff has no matching durable admission");
      if (!resourceHostReady(checked.value.workload.host, await ports.observeHost(checked.value.workload.host))) throw new Error("current resource host observation required before HTTP handoff");
      const service = Object.keys(checked.value.workload.services)[0]; if (service === undefined) throw new Error("complete rollout has no HTTP workload");
      return store.handoffRollout(operation.ticket, service, ports.now());
    }),
    prepareHttpRollout: (app: string, request: string, commit: string, ports: HttpPlanPort & Pick<BuildPorts, "now" | "retain">) => useReady(app, async (store) => {
      if (!z.uuid().safeParse(request).success || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("HTTP rollout requires a request identity and full commit");
      const envelope = await store.read();
      const registration = verifiedRegistration(app, envelope);
      if (envelope?.registrationAllocation?.runtime !== "swarm") throw new Error("HTTP rollout requires the persisted Swarm runtime");
      const existing = envelope.http?.requests.find((item) => item.request === request);
      if (existing !== undefined) {
        if (existing.commit !== commit) throw new Error("HTTP request identity has conflicting commit");
        return existing;
      }
      if (envelope.fence?.lifecycle.phase !== "registered" || envelope.fence.lifecycle.active !== null) throw new Error("HTTP lifecycle is busy or fenced");
      if (envelope.rollout !== undefined || (envelope.rollouts?.length ?? 0) > 0) throw new Error("application requires complete rollout admission");
      const previous = envelope.http?.requests.at(-1);
      if (previous !== undefined) await reconcileHttpResources(app, store, previous.ticket);
      const state = await readIndex();
      const id = createHash("sha256").update(JSON.stringify({ registration, commit })).digest("hex");
      const artifact = state.builds.find((build) => build.id === id)?.artifact;
      if (artifact === undefined || artifact === null) throw new Error("HTTP rollout requires a retained build");
      const checked = parseApplicationPlan(await ports.preview(registration, "swarm", commit, artifact));
      if (!checked.ok) throw new Error(checked.error);
      const plan = checked.value;
      if (JSON.stringify(plan.registration) !== JSON.stringify(registration) || plan.commit !== commit || plan.artifact !== artifact) throw new Error("HTTP plan ownership mismatch");
      const content = JSON.stringify(plan);
      const digest = createHash("sha256").update(content).digest("hex");
      if (await ports.retain(content) !== digest) throw new Error("HTTP plan retention mismatch");
      const service = Object.keys(plan.services)[0];
      if (service === undefined) throw new Error("HTTP plan has no service");
      return store.prepareHttp({ request, plan: digest, commit, service }, ports.now());
    }),
    /** Reconcile intent against the exact retained plan, never a current branch or settings snapshot. */
    admitHttpRollout: (app: string, ticket: string, ports: HostObserver & Pick<BuildPorts, "read" | "now">) => useReady(app, async (store) => {
      const envelope = await store.read();
      const registration = verifiedRegistration(app, envelope);
      const operation = envelope?.http?.requests.find((item) => item.ticket === ticket);
      if (operation?.phase !== "prepared") {
        if (operation?.phase === "admitted") return operation;
        throw new Error("HTTP operation is not prepared for admission");
      }
      const loadPlan = async (digest: string) => {
        const content = await ports.read(digest);
        if (createHash("sha256").update(content).digest("hex") !== digest) throw new Error("retained HTTP plan integrity failed");
        const input: unknown = JSON.parse(content);
        const parsed = parseApplicationPlan(input);
        if (!parsed.ok || JSON.stringify(parsed.value.registration) !== JSON.stringify(registration)) throw new Error("retained HTTP plan authority mismatch");
        return parsed.value;
      };
      const plan = await loadPlan(operation.plan);
      if (plan.commit !== operation.commit || Object.keys(plan.services)[0] !== operation.service) throw new Error("retained HTTP plan request mismatch");
      const amount = Object.values(plan.services).reduce((sum, service) => ({ cpu: sum.cpu + Math.ceil(service.resources.nanoCpus / 1_000_000), memory: sum.memory + service.resources.memoryBytes }), { cpu: 0, memory: 0 });
      const previousPlan = operation.previous === null ? null : await loadPlan(operation.previous.plan);
      if (previousPlan !== null && (JSON.stringify(previousPlan.routes) !== JSON.stringify(plan.routes) || JSON.stringify(Object.keys(previousPlan.services)) !== JSON.stringify(Object.keys(plan.services)))) throw new Error("rolling HTTP requires unchanged service and routing policy");
      const previousAmount = previousPlan === null ? null : Object.values(previousPlan.services).reduce((sum, service) => ({ cpu: sum.cpu + Math.ceil(service.resources.nanoCpus / 1_000_000), memory: sum.memory + service.resources.memoryBytes }), { cpu: 0, memory: 0 });
      const observation = await ports.observeHost(plan.host);
      if (!resourceHostReady(plan.host, observation)) throw new Error("current resource host observation required before HTTP admission");
      await serialIndex(async () => {
        const current = await readIndex();
        const previous = operation.previous === null || previousAmount === null ? null : { plan: httpReleasePlan(operation.previous), budget: previousAmount };
        const intent: ResourceCharge = { app, incarnation: registration.incarnation, sequence: Number(operation.action.split(":")[1]), previous,
          target: { plan: operation.plan, budget: amount }, peak: httpRecoveryPeak(amount, previous?.budget ?? null), deadline: operation.deadline, result: "pending" };
        const decision = reserveResources(current.resources, plan.host, observation, intent, ports.now());
        if (!decision.ok) throw new Error(decision.error);
        await journal.write({ ...current, resources: decision.value });
      });
      return store.admitHttp(ticket);
    }),
    recordHttpNativeIntent: (app: string, ticket: string, step: HttpNativeStep) => useReady(app, async (store) => {
      const envelope = await store.read();
      const operation = envelope?.http?.requests.find((item) => item.ticket === ticket);
      const resources = (await readIndex()).resources?.charges.find((item) => item.app === app);
      if (operation === undefined || envelope === undefined || resources?.result !== "pending" || resources.incarnation !== envelope.tickets.incarnation || resources.sequence !== Number(operation.action.split(":")[1]) || resources.target.plan !== httpReleasePlan(operation) || resources.deadline !== httpAdmissionDeadline(operation, envelope)) throw new Error("HTTP native effect has no matching durable admission");
      if (!hasHttpRecoveryPeak(resources)) throw new Error("HTTP native effect lacks reserved recovery overlap");
      return store.recordHttpStep(ticket, step);
    }),
    httpOperation: (app: string, request: string) => useReady(app, async (store) => (await store.read())?.http?.requests.find((item) => item.request === request)),
    authorizeHttpNative: (app: string, ticket: string, step: HttpNativeStep) => useReady(app, async (store) => {
      const envelope = await store.read();
      const operation = envelope?.http?.requests.find((item) => item.ticket === ticket);
      const parsed = parseHttpNativeStep(step);
      if (!parsed.ok || operation === undefined || envelope?.fence?.lifecycle.phase !== "registered" || envelope.fence.lifecycle.active === null || lifecycleActionId(envelope.fence, envelope.fence.lifecycle.active.sequence) !== operation.action ||
        JSON.stringify(operation.steps.filter((item) => item.effect === parsed.value.effect).at(-1)) !== JSON.stringify(parsed.value) ||
        (operation.phase === "recovering" ? parsed.value.effect === "apply" : parsed.value.effect !== "apply" || (operation.phase !== "applying" && operation.phase !== "verifying"))) return false;
      const charge = (await readIndex()).resources?.charges.find((item) => item.app === app);
      return charge?.result === "pending" && charge.incarnation === envelope.tickets.incarnation && charge.sequence === Number(operation.action.split(":")[1]) && charge.target.plan === httpReleasePlan(operation) && charge.deadline === httpAdmissionDeadline(operation, envelope) &&
        (parsed.value.effect !== "apply" && parsed.value.effect !== "restore" || hasHttpRecoveryPeak(charge));
    }),
    cancelHttpRollout: (app: string, request: string, now: number) => useReady(app, async (store) => {
      const envelope = await store.read();
      const operation = envelope?.http?.requests.find((item) => item.request === request);
      if (operation === undefined) throw new Error("HTTP request is unavailable");
      if (terminalHttp(operation.phase)) return operation;
      return store.cancelHttp(operation.ticket, now);
    }),
    beginHttpRecovery: (app: string, ticket: string, reason: "deadline" | "admission" | "runtime" | "routed", now: number) => useReady(app, (store) => store.beginHttpRecovery(ticket, reason, now)),
    holdHttp: (app: string, ticket: string, reason: "deadline" | "admission" | "runtime" | "routed") => useReady(app, (store) => store.holdHttp(ticket, reason)),
    recordHttpRecoveryIntent: (app: string, ticket: string, step: HttpNativeStep, native: ServiceObservation, now: number) => useReady(app, async (store) => {
      const envelope = await store.read();
      const operation = envelope?.http?.requests.find((item) => item.ticket === ticket);
      const charge = (await readIndex()).resources?.charges.find((item) => item.app === app);
      if (operation === undefined || envelope === undefined || charge?.result !== "pending" || charge.incarnation !== envelope.tickets.incarnation || charge.sequence !== Number(operation.action.split(":")[1]) || charge.target.plan !== httpReleasePlan(operation) || charge.deadline !== httpAdmissionDeadline(operation, envelope)) throw new Error("HTTP recovery effect has no matching durable admission");
      if (step.effect === "restore" && !hasHttpRecoveryPeak(charge)) throw new Error("HTTP restoration lacks reserved recovery overlap");
      return store.recordHttpRecoveryStep(ticket, step, native, now);
    }),
    finishHttpUnstarted: (app: string, ticket: string, reason: "deadline" | "admission" | "runtime") => useReady(app, (store) => store.finishHttpUnstarted(ticket, reason)),
    finishHttpRecovery: (app: string, ticket: string, kind: Exclude<HttpRecovery["kind"], "unstarted">, native: ServiceObservation, routed: RoutedReadiness | null, now: number) => useReady(app, (store) => store.finishHttpRecovery(ticket, kind, native, routed, now)),
    markHttpDispatched: (app: string, ticket: string) => useReady(app, (store) => store.markHttpDispatched(ticket)),
    promoteHttpRollout: (app: string, ticket: string, native: ServiceObservation, routed: RoutedReadiness, now: number) => useReady(app, async (store) => {
      const envelope = await store.read();
      const operation = envelope?.http?.requests.find((item) => item.ticket === ticket);
      const resources = (await readIndex()).resources?.charges.find((item) => item.app === app);
      if (operation === undefined || envelope === undefined || resources?.result !== "pending" || resources.incarnation !== envelope.tickets.incarnation || resources.sequence !== Number(operation.action.split(":")[1]) || resources.target.plan !== httpReleasePlan(operation) || resources.deadline !== httpAdmissionDeadline(operation, envelope)) throw new Error("HTTP promotion has no matching durable admission");
      const verified = await store.promoteHttp(ticket, native, routed, now);
      // A crash here preserves a conservative overlap charge. Recovery settles from the sealed proof.
      await serialIndex(async () => {
        const state = await readIndex();
        const settled = settleResources(state.resources, app, resources.incarnation, resources.sequence, "target");
        if (!settled.ok) throw new Error(settled.error);
        await journal.write({ ...state, resources: settled.value });
      });
      return verified;
    }),
    reconcileHttpResources: (app: string, ticket: string) => useReady(app, (store) => reconcileHttpResources(app, store, ticket)),
    deploymentStatus: (app: string) => useReady(app, async (store) => {
      const envelope = await store.read();
      const registration = verifiedRegistration(app, envelope);
      if (envelope?.fence === null || envelope?.fence === undefined || envelope.registrationAllocation === undefined) throw new Error("deployment status lacks lifecycle authority");
      return deploymentStatus(app, registration.incarnation, envelope.registrationAllocation.runtime, envelope.fence.lifecycle.phase, envelope.http, envelope.rollout);
    }),
    /** Owner-only restart work list; consumers get identities, never journal paths or mutable intent. */
    pendingRolloutOperations: async () => {
      if (closed) throw new Error("lifecycle app index is closed");
      const snapshot = await serialIndex(readIndex);
      const work = await Promise.all(snapshot.apps.filter((app) => app.phase === "ready").map((app) => useReady(app.app, async (store) => {
        const state = await store.read(); const operation = state?.rollout;
        if (operation === undefined || operation.completion === undefined && operation.preparation.phase === "held" &&
          !operation.preparation.sequence?.steps.some((step) => step.attempts.some((attempt) => attempt.cleanups?.at(-1)?.state.phase === "fencing")) &&
          !(operation.preparation.cancelRequestedAt !== undefined && settledMigrationPrefix(operation.preparation.sequence) !== undefined)) return [];
        const http = state?.http?.requests.find((item) => item.request === operation.preparation.run);
        if (http?.phase === "held") return [];
        const charge = snapshot.resources?.charges.find((item) => item.app === app.app);
        const unsettled = charge?.result === "pending" && charge.incarnation === app.incarnation && charge.sequence === Number(operation.action.split(":")[1]);
        return (operation.completion !== undefined || http !== undefined && terminalHttp(http.phase)) && !unsettled ? [] : [Object.freeze({ app: app.app, request: operation.preparation.run })];
      })));
      return Object.freeze(work.flat());
    },
    pendingHttpOperations: async () => {
      if (closed) throw new Error("lifecycle app index is closed");
      const snapshot = await serialIndex(readIndex);
      const work = await Promise.all(snapshot.apps.filter((app) => app.phase === "ready").map((app) => useReady(app.app, async (store) => {
        const envelope = await store.read();
        const latest = envelope?.http?.requests.at(-1);
        if (latest === undefined || latest.phase === "held" || latest.deployment !== undefined) return [];
        const charge = snapshot.resources?.charges.find((item) => item.app === app.app);
        const unsettled = charge?.result === "pending" && charge.incarnation === app.incarnation && charge.sequence === Number(latest.action.split(":")[1]);
        return terminalHttp(latest.phase) && !unsettled ? [] : [Object.freeze({ app: app.app, request: latest.request })];
      })));
      return Object.freeze(work.flat());
    },
    resourceSnapshot: () => {
      if (closed) return Promise.reject(new Error("lifecycle app index is closed"));
      return serialIndex(async () => (await readIndex()).resources);
    },
    imagePins: (ports: Pick<BuildPorts, "read" | "images">) => {
      if (closed) return Promise.reject(new Error("lifecycle app index is closed"));
      return serialIndex(async () => {
        const state = await readIndex();
        const artifacts = await Promise.all(state.builds.flatMap((intent) => intent.artifact === null ? [] : [
          (async () => {
            const content = await ports.read(intent.artifact ?? "");
            const images = ports.images(content, intent.registration, intent.commit);
            const own = new RegExp(`^localhost:5000/${intent.registration.app}/[a-z0-9._/-]+@sha256:[0-9a-f]{64}$`);
            if (images.some((image) => !own.test(image))) throw new Error("invalid image pin ownership");
            return Object.freeze({ build: intent.id, registration: Object.freeze({ ...intent.registration }), commit: intent.commit,
              artifact: intent.artifact ?? "", images: Object.freeze([...new Set(images)].toSorted()) });
          })(),
        ]));
        return typed<BuildImagePins>(Object.freeze({
          version: 1, complete: false, reason: "runtime plan pins are not integrated",
          artifacts: Object.freeze(artifacts),
          unresolved: Object.freeze(state.builds.filter((intent) => intent.artifact === null).map((intent) => Object.freeze({
            build: intent.id, registration: Object.freeze({ ...intent.registration }), commit: intent.commit, deadline: intent.deadline,
          }))),
        }));
      });
    },
    reserveRegistration: (app: string, generation?: string, runtime: Runtime = "compose") => useReady(app, (store) => store.reserveRegistration(generation, runtime)),
    submitRegistration: (app: string, ticket: string, generation: string) =>
      useReady(app, (store) => store.submitRegistration(ticket, generation)),
    reconcileRegistration: (app: string, ticket: string, generation: string) =>
      useReady(app, (store) => store.reconcileRegistration(ticket, generation)),
    close: async () => {
      closed = true;
      await Promise.all(pendingApps.values());
      await pendingIndex;
      await journal.close();
    },
  };
};

/** Explicit provisioning only. An existing directory is never initialized or reset. */
export const createLifecycleAppIndex = async (directory: string, observer?: RegistrationObserver, journals = openJournal) => {
  await mkdir(directory, { mode: 0o700 });
  await syncDirectory(dirname(directory));
  return openIndex(directory, "initialize", observer, journals);
};

/** The trusted coordinator must control the directory and its ancestry. */
export const openLifecycleAppIndex = (directory: string, observer?: RegistrationObserver, journals = openJournal) =>
  openIndex(directory, "existing", observer, journals);
