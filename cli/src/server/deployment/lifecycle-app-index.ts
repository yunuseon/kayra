/* The index owns a live journal lock and serializes its filesystem operations. */
/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/type-declaration-immutability */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { parseApplicationPlan } from "../../contracts/application-plan.ts";
import type { HostObserver } from "../../contracts/resource-authority.ts";
import { parseResourceBook, reserveResources, settleResources } from "./resource-book.ts";
import type { HttpNativeStep } from "./http-state.ts";
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

const openIndex = async (directory: string, mode: "initialize" | "existing", observer?: RegistrationObserver) => {
  await requireDirectory(directory);
  const journal = await openJournal(directory, mode);
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
    const appJournal = await openJournal(path, ownership.phase === "ready" ? "existing" : "initialize");
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
      await serialIndex(async () => {
        const current = await readIndex();
        const previous = operation.previous === null || previousAmount === null ? null : { plan: operation.previous.plan, budget: previousAmount };
        const intent: ResourceCharge = { app, incarnation: registration.incarnation, sequence: Number(operation.action.split(":")[1]), previous,
          target: { plan: operation.plan, budget: amount }, peak: { cpu: amount.cpu + (previous?.budget.cpu ?? 0), memory: amount.memory + (previous?.budget.memory ?? 0) }, deadline: operation.deadline, result: "pending" };
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
      if (operation === undefined || resources?.result !== "pending" || resources.incarnation !== envelope?.tickets.incarnation || resources.sequence !== Number(operation.action.split(":")[1]) || resources.target.plan !== operation.plan || resources.deadline !== operation.deadline) throw new Error("HTTP native effect has no matching durable admission");
      return store.recordHttpStep(ticket, step);
    }),
    httpOperation: (app: string, request: string) => useReady(app, async (store) => (await store.read())?.http?.requests.find((item) => item.request === request)),
    /** Internal owner interface, deliberately not exposed by the registration controller.
     * Reservation is not lifecycle authorization or proof of runtime convergence. */
    reserveHttpResources: (app: string, sequence: number, commit: string, ports: HttpPlanPort & HostObserver & Pick<BuildPorts, "now" | "retain" | "read">) => useReady(app, async (store) => {
      const envelope = await store.read();
      const registration = verifiedRegistration(app, envelope);
      if (envelope?.registrationAllocation?.runtime !== "swarm" || !Number.isSafeInteger(sequence) || sequence < 1 || !/^[0-9a-f]{40}$/.test(commit)) throw new Error("invalid Swarm resource request");
      const state = await readIndex();
      const id = createHash("sha256").update(JSON.stringify({ registration, commit })).digest("hex");
      const artifact = state.builds.find((build) => build.id === id)?.artifact;
      if (artifact === undefined || artifact === null) throw new Error("resource admission requires a retained build");
      const checked = parseApplicationPlan(await ports.preview(registration, "swarm", commit, artifact));
      if (!checked.ok) throw new Error(checked.error);
      const plan = checked.value;
      if (JSON.stringify(plan.registration) !== JSON.stringify(registration) || plan.commit !== commit || plan.artifact !== artifact) throw new Error("resource plan ownership mismatch");
      const content = JSON.stringify(plan);
      const digest = createHash("sha256").update(content).digest("hex");
      if (await ports.retain(content) !== digest) throw new Error("immutable plan retention mismatch");
      const amount = Object.values(plan.services).reduce((sum, service) => ({ cpu: sum.cpu + Math.ceil(service.resources.nanoCpus / 1_000_000), memory: sum.memory + service.resources.memoryBytes }), { cpu: 0, memory: 0 });
      const observation = await ports.observeHost(plan.host);
      return serialIndex(async () => {
        const current = await readIndex();
        const existing = current.resources?.charges.find((item) => item.app === app);
        const previous = existing === undefined ? null : existing.result === "target" ? existing.target : existing.result === "previous" ? existing.previous : null;
        // One stable VIP cannot send A to B's new port during a rolling update.
        if (previous !== null) {
          const previousInput: unknown = JSON.parse(await ports.read(previous.plan));
          const before = parseApplicationPlan(previousInput);
          if (!before.ok || before.value.app !== app || before.value.registration.incarnation !== registration.incarnation || JSON.stringify(before.value.routes) !== JSON.stringify(plan.routes) || JSON.stringify(Object.keys(before.value.services)) !== JSON.stringify(Object.keys(plan.services))) throw new Error("rolling HTTP requires unchanged service and routing policy");
        }
        const replay = existing?.sequence === sequence && existing.incarnation === registration.incarnation;
        const intent: ResourceCharge = { app, incarnation: registration.incarnation, sequence,
          previous: replay ? existing.previous : previous, target: { plan: digest, budget: amount },
          peak: replay ? existing.peak : { cpu: (previous?.budget.cpu ?? 0) + amount.cpu, memory: (previous?.budget.memory ?? 0) + amount.memory },
          deadline: replay ? existing.deadline : ports.now() + 90_000, result: "pending" };
        const decision = reserveResources(current.resources, plan.host, observation, intent, ports.now());
        if (!decision.ok) throw new Error(decision.error);
        await journal.write({ ...current, resources: decision.value });
        return decision.value.charges.find((item) => item.app === app);
      });
    }),
    resourceSnapshot: () => {
      if (closed) return Promise.reject(new Error("lifecycle app index is closed"));
      return serialIndex(async () => (await readIndex()).resources);
    },
    /** Call only after the owning lifecycle reconciler has established runtime state. */
    settleHttpResources: (app: string, incarnation: string, sequence: number, result: "target" | "previous" | "absent") => useReady(app, async (store) => {
      const registration = verifiedRegistration(app, await store.read());
      if (registration.incarnation !== incarnation) throw new Error("resource settlement incarnation mismatch");
      return serialIndex(async () => {
        const state = await readIndex();
        const settled = settleResources(state.resources, app, incarnation, sequence, result);
        if (!settled.ok) throw new Error(settled.error);
        await journal.write({ ...state, resources: settled.value });
      });
    }),
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
export const createLifecycleAppIndex = async (directory: string, observer?: RegistrationObserver) => {
  await mkdir(directory, { mode: 0o700 });
  await syncDirectory(dirname(directory));
  return openIndex(directory, "initialize", observer);
};

/** The trusted coordinator must control the directory and its ancestry. */
export const openLifecycleAppIndex = (directory: string, observer?: RegistrationObserver) =>
  openIndex(directory, "existing", observer);
