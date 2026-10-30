/* AbortSignal is a mutable cancellation primitive. */
/* eslint-disable functional/prefer-immutable-types */
import { err, ok } from "../../lib/result.ts";
import { typed } from "../../lib/typed.ts";
import type { JournalValue } from "./journal.ts";

export type OperationRequest = {
  readonly operationId: string;
  readonly actionId: string;
  /** An immutable admitted plan is looked up and independently verified by the adapter. */
  readonly planDigest: string;
  readonly deadline: number;
  readonly replay: "safe" | "never";
};
export type OperationRecord = OperationRequest & {
  readonly version: 1;
  readonly attempts: 1 | 2;
  readonly phase: "intent" | "verified" | "held";
  readonly reason?: "ambiguous" | "expired" | "unavailable" | "unauthorized";
};
export type ObservationStatus = "applied" | "running" | "absent" | "failed" | "unknown";
export type Observation = { readonly operationId: string; readonly actionId: string; readonly planDigest: string; readonly status: ObservationStatus };
export type OperationJournal = { readonly read: () => Promise<unknown>; readonly write: (value: JournalValue) => Promise<void> };
export type ActionPort = {
  /** Verify the immutable plan, action identity, deadline and replay declaration before an effect. */
  readonly authorize: (record: OperationRecord, signal: AbortSignal) => Promise<boolean>;
  /** Atomically fence attempts by stable action identity; replay must be safe and explicitly admitted. */
  readonly execute: (record: OperationRecord, signal: AbortSignal) => Promise<void>;
  /** `failed` is authoritative terminal evidence: no earlier attempt can still take effect.
   * Missing or eventually-consistent state is `absent` or `unknown`, never `failed`.
   * Adapters honor cancellation and deadlines even when they have already sent a request. */
  readonly observe: (record: OperationRecord, signal: AbortSignal) => Promise<Observation>;
};
export type OperationResult =
  | { readonly kind: "pending"; readonly record: OperationRecord }
  | { readonly kind: "verified"; readonly record: OperationRecord }
  | { readonly kind: "held"; readonly record: OperationRecord };
export type HeldDiagnostic =
  | { readonly kind: "observed"; readonly status: ObservationStatus }
  | { readonly kind: "unavailable" | "timeout" };

const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const claimedJournals = new WeakSet<OperationJournal>();
const object = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

/** No arbitrary payload, error text, command, environment, or resolved secret can enter this record. */
export const parseOperationRecord = (value: unknown) => {
  if (!object(value)) return err("operation record is not an object");
  const keys = ["version", "operationId", "actionId", "planDigest", "deadline", "replay", "attempts", "phase", "reason"];
  if (Object.keys(value).some((key) => !keys.includes(key))) return err("operation record has an unknown field");
  const { version, operationId, actionId, planDigest, deadline, replay, attempts, phase, reason } = value;
  if (version !== 1 || !uuid(operationId) || !uuid(actionId) || typeof planDigest !== "string" || !/^[0-9a-f]{64}$/.test(planDigest)) return err("invalid operation identity");
  if (typeof deadline !== "number" || !Number.isSafeInteger(deadline) || deadline <= 0 || (replay !== "safe" && replay !== "never")) return err("invalid operation deadline or replay declaration");
  if ((attempts !== 1 && attempts !== 2) || (replay === "never" && attempts !== 1)) return err("invalid attempt count");
  if (phase !== "intent" && phase !== "verified" && phase !== "held") return err("invalid operation phase");
  if (reason !== undefined && reason !== "ambiguous" && reason !== "expired" && reason !== "unavailable" && reason !== "unauthorized") return err("invalid operation outcome");
  if ((phase === "held") !== (reason !== undefined)) return err("invalid operation outcome");
  return ok<OperationRecord>(Object.freeze({ version, operationId, actionId, planDigest, deadline, replay, attempts, phase, ...(reason === undefined ? {} : { reason }) }));
};

/**
 * Owns a single journal handle. The composition root must not write through it directly.
 * The journal itself must enforce its exclusive process lock and synchronize writes.
 * This limited coordinator stores no plan. The adapter must retain and validate the
 * immutable plan identified by planDigest and preserve authoritative action evidence.
 */
export const singleEffectCoordinator = (journal: OperationJournal, port: ActionPort, now: () => number) => {
  if (claimedJournals.has(journal)) throw new Error("journal handle already has a coordinator");
  claimedJournals.add(journal);
  // Calls serialize inside one owner as well as across processes at the journal lock.
  // eslint-disable-next-line functional/no-let -- serializes this exclusive writer
  let pending = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>) => {
    const result = pending.then(operation);
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
  const load = async () => {
    const raw = await journal.read();
    if (raw === undefined) return undefined;
    const record = parseOperationRecord(raw);
    if (!record.ok) throw new Error(`invalid operation journal: ${record.error}`);
    return record.value;
  };
  const write = async (record: OperationRecord) => {
    const checked = parseOperationRecord(record);
    if (!checked.ok) throw new Error(`invalid operation journal: ${checked.error}`);
    await journal.write(checked.value);
    return checked.value;
  };
  const time = () => {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid coordinator clock");
    return value;
  };
  const bounded = async <T>(deadline: number, call: (signal: AbortSignal) => Promise<T>) => {
    const remaining = deadline - time();
    if (remaining <= 0) return { kind: "timeout" } as const;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, Math.min(remaining, 2_147_483_647));
    const timeout = new Promise<{ readonly kind: "timeout" }>((resolve) => {
      controller.signal.addEventListener("abort", () => { resolve({ kind: "timeout" }); }, { once: true });
    });
    const result = Promise.resolve().then(() => call(controller.signal)).then(
      (value) => ({ kind: "completed", value } as const),
      () => ({ kind: "error" } as const),
    );
    try { return await Promise.race([timeout, result]); } finally { clearTimeout(timer); }
  };
  const hold = async (record: OperationRecord, reason: "ambiguous" | "expired" | "unavailable" | "unauthorized") => {
    const held = await write({ ...record, phase: "held", reason });
    return typed<OperationResult>({ kind: "held", record: held });
  };
  const execute = async (record: OperationRecord) => {
    // Authorization must be read-only and must check replay safety against the admitted plan.
    const authorization = await bounded(record.deadline, (signal) => port.authorize(record, signal));
    if (authorization.kind === "timeout") return hold(record, "expired");
    const authorizationValue: unknown = authorization.kind === "completed" ? authorization.value : undefined;
    if (authorizationValue !== true) return hold(record, "unauthorized");
    if (time() >= record.deadline) return hold(record, "expired");
    // Aborting the call does not establish whether its external effect stopped.
    const execution = await bounded(record.deadline, (signal) => port.execute(record, signal));
    if (execution.kind === "timeout") return hold(record, "expired");
    return typed<OperationResult>({ kind: "pending", record });
  };
  const start = async (request: OperationRequest) => {
    // Validate and snapshot before yielding to the caller or waiting behind I/O.
    const intent = parseOperationRecord({ ...request, version: 1, attempts: 1, phase: "intent" });
    if (!intent.ok) throw new Error(`invalid operation request: ${intent.error}`);
    return serial(async () => {
      if (await load() !== undefined) throw new Error("journal already holds an operation");
      if (time() >= intent.value.deadline) throw new Error("operation deadline has expired");
      const persisted = await write(intent.value);
      if (time() >= persisted.deadline) return hold(persisted, "expired");
      return execute(persisted);
    });
  };
  // A diagnostic read may have a distinct absolute deadline; it cannot extend the effect deadline.
  const reconcile = (observationDeadline?: number) => serial(async () => {
    const record = await load();
    if (record === undefined) throw new Error("no operation to reconcile");
    if (record.phase === "verified") return typed<OperationResult>({ kind: "verified", record });
    if (record.phase === "held") return typed<OperationResult>({ kind: "held", record });
    if (observationDeadline !== undefined && (!Number.isSafeInteger(observationDeadline) || observationDeadline <= time())) throw new Error("invalid observation deadline");
    const observation = await bounded(observationDeadline ?? record.deadline, (signal) => port.observe(record, signal));
    if (observation.kind === "timeout") return hold(record, "expired");
    const observed = observation.kind === "completed" ? observation.value : undefined;
    if (!object(observed) || observed.operationId !== record.operationId || observed.actionId !== record.actionId || observed.planDigest !== record.planDigest) return hold(record, "unavailable");
    const status = observed.status;
    if (!["applied", "running", "absent", "failed", "unknown"].some((value) => value === status)) return hold(record, "unavailable");
    if (status === "applied") {
      const verified = await write({ ...record, phase: "verified" });
      return typed<OperationResult>({ kind: "verified", record: verified });
    }
    if (status === "unknown") return hold(record, "unavailable");
    if (time() >= record.deadline) return hold(record, "expired");
    if (status === "running") return typed<OperationResult>({ kind: "pending", record });
    if (status !== "failed" || record.replay !== "safe" || record.attempts >= 2) return hold(record, "ambiguous");
    const retry = await write({ ...record, attempts: 2 });
    if (time() >= retry.deadline) return hold(retry, "expired");
    return execute(retry);
  });
  // Diagnostic observations are neither authenticated proof nor an operator
  // resolution. They never change the held record or authorize another effect.
  const inspectHeld = (observationDeadline: number) => serial(async (): Promise<HeldDiagnostic> => {
    const record = await load();
    if (record?.phase !== "held") throw new Error("operation is not held");
    if (!Number.isSafeInteger(observationDeadline) || observationDeadline <= time()) throw new Error("invalid observation deadline");
    const result = await bounded(observationDeadline, (signal) => port.observe(record, signal));
    if (result.kind === "timeout") return { kind: "timeout" };
    const observed: unknown = result.kind === "completed" ? result.value : undefined;
    if (!object(observed) || observed['operationId'] !== record.operationId || observed['actionId'] !== record.actionId || observed['planDigest'] !== record.planDigest) return { kind: "unavailable" };
    const status = observed['status'];
    if (status !== "applied" && status !== "running" && status !== "absent" && status !== "failed" && status !== "unknown") return { kind: "unavailable" };
    return { kind: "observed", status };
  });
  return { start, reconcile, inspectHeld };
};
