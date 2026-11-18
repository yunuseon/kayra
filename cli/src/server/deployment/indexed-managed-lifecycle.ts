import type { OwnedVolumePort } from "../../contracts/owned-volume.ts";
import type { RecordedVolumeReceiptsPort } from "../../contracts/recorded-volume-receipts.ts";
import type { ManagedWorkloadPort } from "../../contracts/managed-workloads.ts";
import { createHash } from "node:crypto";
import type { ManagedAdmissionPort } from "../../contracts/managed-admission.ts";
import type { HostObserver } from "../../contracts/resource-authority.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import { parseManagedLifecycleSource, managedLifecycleSourceDigest } from "./managed-lifecycle-source.ts";
import { managedLifecycleOwner } from "./managed-lifecycle-owner.ts";
import { parseManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import type { ManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import type { openLifecycleEnvelopeStore } from "./lifecycle-envelope-store.ts";
import { managedIndexGate, managedIndexScope } from "./managed-index-admission.ts";
import type { DataOwnership } from "../../contracts/owned-volume.ts";
import { parseMigrationResolutionRequest, parseMigrationResolutionActor } from "../../contracts/migration-resolution.ts";
import type { MigrationResolutionRequest, MigrationResolutionActor } from "../../contracts/migration-resolution.ts";
import { managedLifecycleDescription } from "./managed-lifecycle-source.ts";
import type { OperationJournal } from "./operation.ts";
import type { IndexEntry } from "./lifecycle-app-index-state.ts";

export type IndexedManagedRuntime = Omit<Parameters<typeof managedLifecycleOwner>[2], "admission"> & HostObserver & {
  /** Current fleet grants, feature enablement and independently validated compiler/build inputs. No shared gate or workload authority is granted by this preflight. */
  readonly managedData?: { readonly native: Readonly<Pick<OwnedVolumePort, "observe" | "create">>; readonly workloads: (receipts: RecordedVolumeReceiptsPort) => ManagedWorkloadPort } | undefined;
  readonly requestAllowed: (source: ManagedLifecycleSource) => Promise<boolean>;
};
type Envelope = Readonly<ReturnType<typeof openLifecycleEnvelopeStore>>;
export type IndexedManagedContext = {
  readonly ownership: DataOwnership; readonly envelope: Envelope; readonly journal: OperationJournal;
  readonly indexedOwner: () => Promise<IndexEntry>;
  readonly ready: (root: ManagedLifecycleStore, source: ManagedLifecycleSource) => Promise<void>;
  /** Uses the existing global writer, re-reading root/request/owner for every decision. */
  readonly admission: (read: () => Promise<{ readonly state: ManagedLifecycleStore; readonly source: ManagedLifecycleSource }>) => ManagedAdmissionPort;
  readonly preparedBuild: (source: ManagedLifecycleSource) => Promise<boolean>;
};

/** Storage/lifecycle composition only. No fleet interpretation, raw Docker, forge access, private platform files or application recovery logic. */
export const indexedManagedLifecycle = (context: IndexedManagedContext, ports: IndexedManagedRuntime) => {
  const bounded = async <T>(deadline: number, call: () => Promise<T>) => {
    const left = Math.min(10_000, deadline - ports.now()); if (!Number.isFinite(left) || left <= 0) return undefined;
    const timeout = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { timeout.resolve(undefined); }, left);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), timeout.promise]); } finally { clearTimeout(timer); }
  };
  const scope = async (source: ManagedLifecycleSource) => { const envelope: unknown = await context.envelope.read(); return Object.freeze({ owner: await context.indexedOwner(), envelope, source }); };
  const admission = context.admission(async () => { const state = await owner.read(); if (state === undefined) throw new Error("managed indexed root is missing"); return Object.freeze({ state, source: await owner.source() }); });
  const owner = managedLifecycleOwner(context.journal, context.ownership, { ...ports, admission, authorize: async (source, effect) => {
    const gate = managedIndexGate(await scope(source));
    if (!gate.ok || gate.value.request.completion !== null) return false;
    return effect.kind === "accepted-recovery" ? JSON.stringify(effect.request) === JSON.stringify(gate.value.request) : gate.value.activeGate && await ports.authorize(source, effect);
  } });
  const synchronize = async () => {
    const root = await owner.read(); if (root === undefined) return;
    const source = await owner.source(); const gate = managedIndexGate(await scope(source));
    if (!gate.ok || gate.value.request.source !== root.operation.source || gate.value.request.completion !== null && gate.value.request.completion.rootSnapshot !== createHash("sha256").update(JSON.stringify(root)).digest("hex")) throw new Error("indexed managed root lacks its shared request");
    await context.ready(root, source);
  };
  const request = async (run: string) => {
    const value = (await context.envelope.read())?.managed?.find((item) => item.run === run); if (value === undefined) throw new Error("managed indexed request is missing"); return value;
  };
  const retainedSource = async (value: Awaited<ReturnType<typeof request>>) => {
    const bytes = await bounded(ports.now() + 10_000, () => ports.read(value.source));
    if (bytes === undefined || createHash("sha256").update(bytes).digest("hex") !== value.source) throw new Error("managed indexed source is unavailable");
    const raw: unknown = JSON.parse(bytes); const source = parseManagedLifecycleSource(raw); const gate = managedIndexGate(await scope(source));
    if (bytes !== JSON.stringify(source) || !gate.ok || JSON.stringify(gate.value.request) !== JSON.stringify(value)) throw new Error("managed indexed source binding disagrees"); return source;
  };
  const resume = async (source: ManagedLifecycleSource, value: Awaited<ReturnType<typeof request>>) => {
    try { await owner.begin(source); } catch { await owner.adoptAccepted(source, value); }
    await synchronize();
  };
  return Object.freeze({
    synchronize,
    prepare: async (input: ManagedLifecycleSource) => {
      const source = parseManagedLifecycleSource(input); const existing = (await context.envelope.read())?.managed?.find((item) => item.run === source.run);
      if (existing !== undefined) { if (existing.source !== managedLifecycleSourceDigest(source)) throw new Error("managed indexed request conflicts"); if (existing.completion === null) await resume(source, existing); return existing; }
      if (ports.managedData !== undefined && source.version !== 2) throw new Error("new indexed catalog deployments require allocation source version 2");
      const deadline = source.createdAt + 90_000; const checked = managedIndexScope(await scope(source));
      if (!checked.ok || await bounded(deadline, () => ports.requestAllowed(source)) !== true || await bounded(deadline, () => context.preparedBuild(source)) !== true || await bounded(deadline, () => owner.validate(source)) === undefined) throw new Error("managed indexed request preflight refused");
      if (await bounded(deadline, () => ports.retain(JSON.stringify(source))) !== managedLifecycleSourceDigest(source)) throw new Error("managed indexed source retention failed");
      const accepted = await context.envelope.prepareManaged(source, ports.now()); await resume(source, accepted); return accepted;
    },
    tick: async (run: string) => {
      const value = await request(run); if (value.completion !== null) { const root = await owner.read(); return root?.operation.run === run ? root : undefined; }
      const source = await retainedSource(value); await resume(source, value); const root = await owner.tick(); await synchronize();
      if (root?.operation.phase === "complete") {
        const description = managedLifecycleDescription(source); const operation = root.operation;
        const observed = await bounded(ports.now() + 10_000, () => admission.observe({ owner: root.owner, run: operation.run, action: operation.action, source: operation.source, plan: operation.plan, deadline: operation.admissionDeadline }, description.admission));
        if (operation.settlement === null || observed !== `settled-${operation.settlement}`) throw new Error("managed completion lacks shared accounting settlement");
        const bytes = JSON.stringify(root); const digest = await bounded(ports.now() + 10_000, () => ports.retain(bytes));
        if (digest !== createHash("sha256").update(bytes).digest("hex")) throw new Error("managed completion snapshot retention failed"); await context.envelope.completeManaged(root, digest);
      }
      return root;
    },
    cancel: async (run: string) => { const value = await request(run); if (value.completion !== null) return owner.read(); await resume(await retainedSource(value), value); const root = await owner.cancel(); await synchronize(); return root; },
    resolve: async (input: MigrationResolutionRequest, actor: MigrationResolutionActor) => {
      const statement = parseMigrationResolutionRequest(input); const identity = parseMigrationResolutionActor(actor); if (!statement.ok || !identity.ok) throw new Error("invalid indexed migration resolution");
      const value = await request(input.run); const source = await retainedSource(value);
      if (value.completion === null) { await resume(source, value); return owner.resolveMigration(statement.value, identity.value); }
      const completion = value.completion; const bytes = await bounded(ports.now() + 10_000, () => ports.read(completion.rootSnapshot));
      if (bytes === undefined || createHash("sha256").update(bytes).digest("hex") !== completion.rootSnapshot) throw new Error("completed managed audit snapshot is unavailable");
      const raw: unknown = JSON.parse(bytes); const root = parseManagedLifecycleStore(raw); const operation = root.operation;
      const audit = operation.preparation?.sequence?.steps.find((step) => step.id === statement.value.step)?.resolution; const receipt = operation.resolutionReceipts.find((item) => item.step === statement.value.step);
      if (bytes !== JSON.stringify(root) || root.owner.app !== statement.value.app || JSON.stringify(root.owner) !== JSON.stringify(value.owner) || operation.run !== value.run || operation.source !== value.source || operation.action !== value.action || operation.plan !== value.plan || operation.phase !== "complete" || !operation.settled || operation.outcome !== completion.outcome || audit === undefined || receipt === undefined || audit.outcome !== statement.value.outcome || audit.reason !== statement.value.reason || JSON.stringify(audit.actor) !== JSON.stringify(identity.value) ||
        await bounded(ports.now() + 10_000, () => ports.authorize(source, { kind: "migration-resolution", request: statement.value, actor: identity.value })) !== true) throw new Error("completed managed migration assertion conflicts or is not authorized");
      return Object.freeze({ state: root, receipt });
    },
    read: owner.read,
  });
};
