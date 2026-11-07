/* The index owns a live journal lock and serializes its filesystem operations. */
/* eslint-disable functional/no-let, functional/prefer-immutable-types, functional/type-declaration-immutability */
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { names } from "../../lib/names.ts";
import { openJournal } from "./journal.ts";
import { openLifecycleEnvelopeStore, type RegistrationObserver } from "./lifecycle-envelope-store.ts";

const appName = z.string().regex(names.app.pattern);
const entry = z.object({
  app: appName,
  incarnation: z.uuid(),
  phase: z.enum(["initializing", "ready"]),
}).strict();
const schema = z.object({ version: z.literal(1), apps: z.array(entry) }).strict().refine(({ apps }) =>
  new Set(apps.map((app) => app.app)).size === apps.length &&
  new Set(apps.map((app) => app.incarnation)).size === apps.length,
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

const openIndex = async (directory: string, mode: "initialize" | "existing", observer?: RegistrationObserver) => {
  await requireDirectory(directory);
  const journal = await openJournal(directory, mode);
  const readIndex = async () => {
    const checked = schema.safeParse(await journal.read());
    if (!checked.success) throw new Error("lifecycle app index is invalid; intervention required");
    return checked.data;
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
    reserveRegistration: (app: string) => useReady(app, (store) => store.reserveRegistration()),
    submitRegistration: (app: string, ticket: string, generation: string) =>
      useReady(app, (store) => store.submitRegistration(ticket, generation)),
    reconcileRegistration: (app: string, ticket: string, generation: string) =>
      useReady(app, (store) => store.reconcileRegistration(ticket, generation)),
    close: async () => {
      closed = true;
      await Promise.all(pendingApps.values());
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
