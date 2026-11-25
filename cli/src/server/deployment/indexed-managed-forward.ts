import { createHash } from "node:crypto";
import { parseManagedApplicationPlan, managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import { parseManagedForwardCleanupContext } from "../../contracts/managed-forward-cleanup-context.ts";
import type { ManagedForwardCleanupContext, ManagedForwardCleanupRuntimePort } from "../../contracts/managed-forward-cleanup-context.ts";
import type { RetainedInputsPort } from "../../contracts/service-inputs.ts";
import type { openLifecycleEnvelopeStore } from "./lifecycle-envelope-store.ts";
import type { OperationJournal } from "./operation.ts";
import type { ManagedLifecycleStore } from "./managed-lifecycle-state.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";
import type { ManagedForwardReservation } from "./managed-forward-reservation.ts";
import { managedForwardEffectIntent } from "./managed-forward-effect-intent.ts";
import { prepareManagedForwardEffectSource } from "./managed-forward-effect-source.ts";
import type { ManagedForwardEffectSource } from "./managed-forward-effect-source.ts";
import { parseManagedForwardEffects } from "./managed-forward-effect-state.ts";
import type { ManagedForwardEffects } from "./managed-forward-effect-state.ts";
import { managedForwardEffects } from "./managed-forward-effects.ts";
import { managedSourceContext } from "./managed-source-context.ts";
import { managedRecoveryCheckTargets } from "./managed-recovery-safety.ts";
import { parseManagedLifecycleSource } from "./managed-lifecycle-source.ts";

type Context = { readonly envelope: Readonly<Pick<ReturnType<typeof openLifecycleEnvelopeStore>, "read" | "publishManagedForwardCleanup" | "holdManagedForwardInitialization">>;
  readonly root: () => Promise<ManagedLifecycleStore>; readonly selection: ManagedForwardReservation["selection"];
  readonly openEffects: (mode: "initialize" | "existing") => Promise<OperationJournal & { readonly close: () => Promise<void> }>;
  readonly reserved: (state: ManagedLifecycleStore, source: ManagedLifecycleSource) => Promise<boolean> };
type Ports = RetainedInputsPort & { readonly now: () => number; readonly read: (digest: string) => Promise<string>; readonly retain: (bytes: string) => Promise<string> };
const hash = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const statics = (state: ManagedForwardEffects) => Object.freeze(state.nodes.map(({ name, plan, prior, waitFor, checks }) => Object.freeze({ name, plan, prior, waitFor, checks })));

/** Indexed app writer owns every handle. Initializing permits child creation; published references only reopen existing journals. No admission or successor starts. */
export const indexedManagedForward = (context: Context, ports: Ports) => {
  const bounded = async <T>(deadline: number, call: () => Promise<T>) => { const left = Math.min(10_000, deadline - ports.now()); if (left <= 0) return undefined;
    const expired = Promise.withResolvers<undefined>(); const timer = setTimeout(() => { expired.resolve(undefined); }, left);
    try { return await Promise.race([Promise.resolve().then(call).catch(() => undefined), expired.promise]); } finally { clearTimeout(timer); }
  };
  const artifact = async (digest: string) => {
    const bytes = await bounded(ports.now() + 10_000, () => ports.read(digest)); if (bytes === undefined || hash(bytes) !== digest) throw new Error("forward cleanup artifact unavailable"); return bytes;
  };
  const reservation = async () => {
    const envelope = await context.envelope.read(); const value = envelope?.forward;
    if (value === undefined || !same(value.selection, context.selection)) throw new Error("forward cleanup lost its accepted reservation"); return value;
  };
  const live = async (record: ManagedForwardReservation, source: ManagedLifecycleSource) => {
    const root = await context.root();
    return hash(JSON.stringify(root)) === record.blocked.checkpoint && root.operation.source === record.blocked.source && root.operation.run === record.blocked.run && await context.reserved(root, source);
  };
  const ready = async (record: ManagedForwardReservation, journal: OperationJournal) => {
    if (record.phase !== "fencing") throw new Error("forward cleanup source is not published");
    const bytes = await artifact(record.cleanup); const raw: unknown = JSON.parse(bytes); const intent = managedForwardEffectIntent(raw);
    const state = parseManagedForwardEffects(await journal.read()); const source = intent.source;
    if (bytes !== intent.bytes || state.source !== record.cleanup || state.run !== record.run || state.action !== record.action || state.createdAt !== record.createdAt || state.deadline !== record.deadline || state.app !== record.owner.app || state.incarnation !== record.owner.incarnation || state.dataOwner !== record.owner.dataOwner ||
      source.request.run !== record.run || source.request.action !== record.action || source.request.createdAt !== record.createdAt || source.deadline !== record.deadline || source.candidate.commit !== record.build.commit || source.candidate.artifact !== record.build.artifact || !same(source.candidate.infrastructure.registration, record.build.registration) || source.request.reason !== record.operator.reason || source.decision !== record.selection.decision || hash(JSON.stringify(source.baseline.state)) !== record.blocked.checkpoint || !same(statics(state), statics(intent.state))) throw new Error("forward cleanup journal binding disagrees");
    return Object.freeze({ source, state });
  };
  const execution = (record: ManagedForwardReservation, source: ManagedForwardEffectSource) => {
    if (record.phase !== "fencing") throw new Error("forward cleanup context is not published");
    const value = parseManagedForwardCleanupContext({ version: 1, protocol: "managed-v3", runtime: "swarm", kind: "forward-cleanup", blocked: managedSourceContext(source.baseline.source), run: record.run, action: record.action, source: record.cleanup, reservation: hash(JSON.stringify(record)), createdAt: record.createdAt, deadline: record.deadline,
      checks: managedRecoveryCheckTargets(source.baseline.state, source.baseline.source) ?? Object.freeze([]),
    }); if (!value.ok) throw new Error(value.error); return value.value;
  };
  return Object.freeze({
    prepare: async () => {
      const record = await reservation();
      if (record.phase === "held") return Object.freeze({ reservation: record, source: null, state: null });
      if (record.phase === "fencing") { const journal = await context.openEffects("existing"); try { return Object.freeze({ reservation: record, ...await ready(record, journal) }); } finally { await journal.close(); } }
      if (ports.now() < record.createdAt) throw new Error("forward cleanup initialization clock moved backwards");
      if (ports.now() >= record.deadline) return Object.freeze({ reservation: await context.envelope.holdManagedForwardInitialization(record, ports.now()), source: null, state: null });
      const raw: unknown = JSON.parse(await artifact(record.candidate)); const candidate = parseManagedApplicationPlan(raw);
      if (!candidate.ok || managedApplicationDigest(candidate.value) !== record.candidate || JSON.stringify(candidate.value) !== JSON.stringify(raw)) throw new Error("forward cleanup candidate integrity failed");
      const old: unknown = JSON.parse(await artifact(record.blocked.source)); const source = parseManagedLifecycleSource(old);
      if (!await live(record, source)) throw new Error("forward cleanup held checkpoint or pending admission changed");
      const prepared = await prepareManagedForwardEffectSource({ version: 1, kind: "managed-forward-effect-source", decision: record.selection.decision, baseline: { state: await context.root(), source }, candidate: candidate.value,
        request: { run: record.run, action: record.action, createdAt: record.createdAt, reason: record.operator.reason }, deadline: record.deadline }, ports);
      const intent = managedForwardEffectIntent(prepared);
      if (await bounded(record.deadline, () => ports.retain(intent.bytes)) !== intent.state.source || ports.now() >= record.deadline) throw new Error("forward cleanup source retention expired or unavailable");
      // Acquire owned handles outside abandonable permission callbacks; always await acquisition and close after a late deadline.
      const journal = await context.openEffects("initialize");
      try {
        if (ports.now() >= record.deadline) throw new Error("forward cleanup initialization deadline expired");
        const old = await journal.read(); if (old === undefined) await journal.write(intent.state); else if (!same(parseManagedForwardEffects(old), intent.state)) throw new Error("forward cleanup initialization conflicts");
        const published = await context.envelope.publishManagedForwardCleanup(record, intent.source);
        return Object.freeze({ reservation: published, source: intent.source, state: intent.state });
      } finally { await journal.close(); }
    },
    context: async () => { const record = await reservation(); const journal = await context.openEffects("existing"); try { const proof = await ready(record, journal); return execution(record, proof.source); } finally { await journal.close(); } },
    tick: async (factory: (context: ManagedForwardCleanupContext) => ManagedForwardCleanupRuntimePort) => {
      const record = await reservation(); const journal = await context.openEffects("existing");
      try {
        const proof = await ready(record, journal); if (proof.state.phase !== "fencing") return proof.state;
        const input = execution(record, proof.source); const runtime = factory(input); if (!same(runtime.context, input)) throw new Error("forward cleanup runtime context disagrees");
        const owner = managedForwardEffects(journal, { ...ports, ...runtime, authorize: async (source, action) => {
          const current = await reservation(); return current.phase === "fencing" && hash(JSON.stringify(current)) === input.reservation && hash(JSON.stringify(source)) === current.cleanup && await live(current, source.baseline.source) && await runtime.allowed(action);
        } });
        return await owner.tick();
      } finally { await journal.close(); }
    },
  });
};
