/* Parsing JSON creates temporary objects; this module also owns live writer handles. */
/* eslint-disable functional/prefer-immutable-types */
import { reserve, type AdmissionState, type Budget, type Reservation } from './admission.ts';
import { parseOperationRecord, type OperationJournal, type OperationRecord, type OperationRequest } from './operation.ts';

export type LedgerEntry = {
  readonly app: string;
  readonly request: OperationRequest;
  readonly record: OperationRecord | null;
};
type Ledger = { readonly version: 1; readonly admission: AdmissionState; readonly operations: readonly LedgerEntry[] };
type Journal = OperationJournal;

/* This is a storage primitive, not runtime admission. Its caller must bind the
 * budget and replay policy to a validated immutable plan, account for observed
 * workloads, and authenticate runtime observations. Leases are deliberately
 * never released here, including after expiry or verification. Until a
 * recovery-capable composition root supplies those guarantees, keep this
 * primitive disconnected from the legacy Compose startup journal. */

const object = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);
const exact = (value: Readonly<Record<string, unknown>>, keys: readonly string[]) => Object.keys(value).length === keys.length && Object.keys(value).every((key) => keys.includes(key));
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const budget = (value: unknown) => object(value) && exact(value, ['cpu', 'memory']) && positive(value['cpu']) && positive(value['memory']) ? { cpu: value['cpu'], memory: value['memory'] } : undefined;
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const appName = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) && value.length <= 48;
const sameRequest = (a: OperationRequest, b: OperationRequest) => a.operationId === b.operationId && a.actionId === b.actionId && a.planDigest === b.planDigest && a.deadline === b.deadline && a.replay === b.replay;
const request = (value: unknown) => {
  if (!object(value) || !exact(value, ['operationId', 'actionId', 'planDigest', 'deadline', 'replay'])) return undefined;
  const parsed = parseOperationRecord({ ...value, version: 1, attempts: 1, phase: 'intent' });
  if (!parsed.ok) return undefined;
  const { operationId, actionId, planDigest, deadline, replay } = parsed.value;
  return { operationId, actionId, planDigest, deadline, replay };
};
const admission = (value: unknown) => {
  if (!object(value) || !exact(value, ['capacity', 'platform', 'workloads', 'reservations'])) return undefined;
  const capacity = budget(value['capacity']);
  const platform = budget(value['platform']);
  if (capacity === undefined || platform === undefined || !Array.isArray(value['workloads']) || !Array.isArray(value['reservations']) || value['workloads'].length > 128 || value['reservations'].length > 128) return undefined;
  const workloads = value['workloads'].map((item: unknown) => {
    if (!object(item) || !exact(item, ['id', 'budget']) || !id(item['id'])) return undefined;
    const amount = budget(item['budget']);
    return amount === undefined ? undefined : { id: item['id'], budget: amount };
  });
  const reservations = value['reservations'].map((item: unknown) => {
    if (!object(item) || !exact(item, ['id', 'budget', 'deadline']) || !id(item['id']) || !positive(item['deadline'])) return undefined;
    const amount = budget(item['budget']);
    return amount === undefined ? undefined : { id: item['id'], budget: amount, deadline: item['deadline'] };
  });
  if (workloads.some((item) => item === undefined) || reservations.some((item) => item === undefined)) return undefined;
  const active = workloads.filter((item) => item !== undefined);
  const leases = reservations.filter((item) => item !== undefined);
  if (new Set(active.map((item) => item.id)).size !== active.length || new Set(leases.map((item) => item.id)).size !== leases.length) return undefined;
  const total = [...active, ...leases].reduce<Budget>((sum, item) => ({ cpu: sum.cpu + item.budget.cpu, memory: sum.memory + item.budget.memory }), platform);
  if (!Number.isSafeInteger(total.cpu) || !Number.isSafeInteger(total.memory) || total.cpu > capacity.cpu || total.memory > capacity.memory) return undefined;
  return { capacity, platform, workloads: active, reservations: leases };
};
const parseLedger = (value: unknown) => {
  if (!object(value) || !exact(value, ['version', 'admission', 'operations']) || value['version'] !== 1 || !Array.isArray(value['operations']) || value['operations'].length > 128) return undefined;
  const resources = admission(value['admission']);
  if (resources === undefined) return undefined;
  const operations = value['operations'].map((item: unknown) => {
    if (!object(item) || !exact(item, ['app', 'request', 'record']) || !appName(item['app'])) return undefined;
    const parsedRequest = request(item['request']);
    if (parsedRequest === undefined) return undefined;
    if (item['record'] === null) return { app: item['app'], request: parsedRequest, record: null };
    const parsedRecord = parseOperationRecord(item['record']);
    return !parsedRecord.ok || !sameRequest(parsedRequest, parsedRecord.value) ? undefined : { app: item['app'], request: parsedRequest, record: parsedRecord.value };
  });
  if (operations.some((item) => item === undefined)) return undefined;
  const entries = operations.filter((item) => item !== undefined);
  if (new Set(entries.map((item) => item.request.operationId)).size !== entries.length || new Set(entries.map((item) => item.request.actionId)).size !== entries.length || new Set(entries.map((item) => item.app)).size !== entries.length || resources.reservations.length !== entries.length) return undefined;
  if (entries.some((item) => !resources.reservations.some((lease) => lease.id === item.request.operationId && lease.deadline === item.request.deadline))) return undefined;
  return { version: 1, admission: resources, operations: entries } as const;
};
const claims = new WeakSet<Journal>();

/** Owns a journal handle exclusively; never share it with another coordinator. */
export const openLedger = async (journal: Journal, initial: AdmissionState, now: () => number) => {
  if (claims.has(journal)) throw new Error('journal handle is already owned');
  claims.add(journal);
  const ledger = await (async () => {
    const initialAdmission = admission(initial);
    if (initialAdmission?.reservations.length !== 0) throw new Error('invalid initial admission');
    const raw = await journal.read();
    const loaded = raw === undefined ? { version: 1, admission: initialAdmission, operations: [] } as const : parseLedger(raw);
    if (loaded === undefined) throw new Error('invalid lifecycle ledger');
    if (JSON.stringify(loaded.admission.capacity) !== JSON.stringify(initialAdmission.capacity) || JSON.stringify(loaded.admission.platform) !== JSON.stringify(initialAdmission.platform) || JSON.stringify(loaded.admission.workloads) !== JSON.stringify(initialAdmission.workloads)) throw new Error('host capacity or workloads require reconciliation');
    if (raw === undefined) await journal.write(loaded);
    return loaded;
  })().catch((error: unknown) => {
    // A failed open must not permanently claim a handle. Concurrent opens are
    // still excluded while the initialization and any write are in flight.
    claims.delete(journal);
    throw error;
  });
  // eslint-disable-next-line functional/no-let -- serializes all operations on this journal
  let pending = Promise.resolve();
  const handles = new Set<string>();
  const admitted = new Set(ledger.operations.map((entry) => entry.request.operationId));
  const serial = <T>(task: () => Promise<T>) => {
    const result = pending.then(task);
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
  const load = async () => {
    const current = parseLedger(await journal.read());
    if (current === undefined) throw new Error('invalid lifecycle ledger');
    return current;
  };
  const admit = (app: string, requested: OperationRequest, requestedBudget: Budget) => {
    // Snapshot at invocation, before waiting behind any earlier journal operation.
    const candidate = request(requested);
    const amount = budget(requestedBudget);
    if (!appName(app) || candidate === undefined || amount === undefined) return Promise.reject(new Error('invalid operation request or budget'));
    return serial(async () => {
      const current = await load();
      const existing = current.operations.find((entry) => entry.request.operationId === candidate.operationId);
      if (existing !== undefined) {
        const lease = current.admission.reservations.find((item) => item.id === candidate.operationId);
        if (existing.app === app && sameRequest(existing.request, candidate) && lease?.budget.cpu === amount.cpu && lease.budget.memory === amount.memory) {
          // A custom journal may persist a write but lose its acknowledgement.
          // A matching reread establishes the durable admission before exposing a handle.
          // eslint-disable-next-line functional/immutable-data -- mirror the confirmed durable admission
          admitted.add(candidate.operationId);
          return;
        }
        throw new Error('operation identity has conflicting intent or budget');
      }
      if (current.operations.some((entry) => entry.request.actionId === candidate.actionId || entry.app === app)) throw new Error('action or app already has a lease');
      const lease: Reservation = { id: candidate.operationId, budget: amount, deadline: candidate.deadline };
      const decision = reserve(current.admission, lease, now());
      if (!decision.ok) throw new Error(decision.error);
      const next: Ledger = { version: 1, admission: decision.value, operations: [...current.operations, { app, request: candidate, record: null }] };
      if (parseLedger(next) === undefined) throw new Error('invalid lifecycle ledger');
      await journal.write(next);
      // eslint-disable-next-line functional/immutable-data -- mirror durable admissions for synchronous handle creation
      admitted.add(candidate.operationId);
    });
  };
  const journalFor = (operationId: string) => {
    if (!admitted.has(operationId)) throw new Error('operation is not admitted');
    if (handles.has(operationId)) throw new Error('operation handle is already owned');
    // eslint-disable-next-line functional/immutable-data -- prevents duplicate in-process coordinators
    handles.add(operationId);
    return {
      read: () => serial(async () => {
        const entry = (await load()).operations.find((item) => item.request.operationId === operationId);
        if (entry === undefined) throw new Error('operation is not admitted');
        return entry.record ?? undefined;
      }),
      write: (value: unknown) => {
        // Validate and snapshot before the async queue can yield to the caller.
        const parsed = parseOperationRecord(value);
        if (!parsed.ok) return Promise.reject(new Error('invalid operation record'));
        const after = parsed.value;
        return serial(async () => {
          const current = await load();
          const entry = current.operations.find((item) => item.request.operationId === operationId);
          if (entry === undefined || !sameRequest(entry.request, after)) throw new Error('operation intent does not match its admission');
          const before = entry.record;
          if (before === null ? after.phase !== 'intent' || after.attempts !== 1 : before.phase !== 'intent' || (after.phase === 'intent' ? before.replay !== 'safe' || before.attempts !== 1 || after.attempts !== 2 : before.attempts !== after.attempts)) throw new Error('invalid operation transition');
          const next: Ledger = { ...current, operations: current.operations.map((item) => item === entry ? { ...item, record: after } : item) };
          if (parseLedger(next) === undefined) throw new Error('invalid lifecycle ledger');
          await journal.write(next);
        });
      },
    };
  };
  // Only an operation without a persisted intent can be established as unstarted.
  // Keep its lease charged; settlement requires runtime-specific reconciliation.
  const expireUnstarted = (operationId: string) => serial(async () => {
    const current = await load();
    const entry = current.operations.find((item) => item.request.operationId === operationId);
    if (entry === undefined) throw new Error('operation is not admitted');
    if (entry.record !== null) throw new Error('operation already has a recorded intent or outcome');
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('invalid coordinator clock');
    if (time < entry.request.deadline) throw new Error('operation deadline has not expired');
    const record = parseOperationRecord({ ...entry.request, version: 1, attempts: 1, phase: 'held', reason: 'expired' });
    if (!record.ok) throw new Error('invalid operation record');
    const next: Ledger = { ...current, operations: current.operations.map((item) => item === entry ? { ...item, record: record.value } : item) };
    if (parseLedger(next) === undefined) throw new Error('invalid lifecycle ledger');
    await journal.write(next);
  });
  const projections = () => serial(async () => Object.freeze((await load()).operations.map((entry) => Object.freeze({
    app: entry.app, operationId: entry.request.operationId, phase: entry.record?.phase ?? 'admitted', deadline: entry.request.deadline,
    ...(entry.record?.reason === undefined ? {} : { requiredAction: entry.record.reason }),
  }))));
  // Internal recovery reads the complete persisted request; this is not a public read model.
  const recoveries = () => serial(async () => {
    const current = await load();
    return Object.freeze(current.operations.map((entry) => {
      const lease = current.admission.reservations.find((item) => item.id === entry.request.operationId);
      if (lease === undefined) throw new Error('operation has no admission lease');
      return Object.freeze({ app: entry.app, request: Object.freeze({ ...entry.request }),
        record: entry.record === null ? null : Object.freeze({ ...entry.record }),
        lease: Object.freeze({ ...lease, budget: Object.freeze({ ...lease.budget }) }) });
    }));
  });
  return { admit, journalFor, expireUnstarted, projections, recoveries };
};
