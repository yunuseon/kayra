/* eslint-disable functional/no-let -- serializes one platform allocation and poisons uncertain storage until reopen */
import { z } from "zod";
import { appOverlayActionSchema, parseAppOverlayGrant, parseAppOverlayScope } from "../../contracts/app-overlay.ts";
import type { AppOverlayAction, AppOverlayGrant, AppOverlayPort, AppOverlayScope } from "../../contracts/app-overlay.ts";
import { parseRegistrationOwnership } from "../../contracts/registration-ownership.ts";
import type { RegistrationOwnership } from "../../contracts/registration-ownership.ts";
import { err, ok } from "../../lib/result.ts";
import { typed } from "../../lib/typed.ts";
import { provisionAppOverlay } from "./app-overlay.ts";

type Allocation = { readonly version: 1; readonly registration: RegistrationOwnership; readonly createdAt: number; readonly action: AppOverlayAction; readonly grant: AppOverlayGrant | null };
export type AppOverlayStorage = {
  readonly read: () => Promise<unknown>;
  readonly write: (record: Allocation) => Promise<void>;
};
type Ports = {
  readonly storage: AppOverlayStorage;
  readonly native: AppOverlayPort;
  readonly authorize: (reference: RegistrationOwnership) => Promise<boolean>;
  readonly now: () => number;
  readonly newId: () => string;
};
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const stateSchema = z.object({ version: z.literal(1), registration: z.unknown(), createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), action: appOverlayActionSchema, grant: z.unknown() }).strict();
const parse = (raw: unknown) => {
  const checked = stateSchema.safeParse(raw); if (!checked.success) return undefined; const value = checked.data;
  const registration = parseRegistrationOwnership(value.registration); const action = { data: value.action };
  const grant = value.grant === null ? null : parseAppOverlayGrant(value.grant); const createdAt = value.createdAt;
  if (!registration.ok || grant !== null && !grant.ok || action.data.deadline - createdAt !== 90000) return undefined;
  if (registration.value.registration.app !== action.data.scope.app || registration.value.registration.incarnation !== action.data.scope.incarnation || grant !== null && !same(grant.value.scope, action.data.scope)) return undefined;
  return typed<Allocation>(Object.freeze({ version: 1, registration: registration.value, createdAt, action: action.data, grant: grant === null ? null : grant.value }));
};

/** Storage is supplied by the composition root. No deployment journal or filesystem layout is interpreted here. */
export const appOverlayAllocation = (ports: Ports) => {
  let pending = Promise.resolve(); let failed = false;
  const save = async (record: Allocation) => {
    try { await ports.storage.write(record); }
    catch { failed = true; throw new Error("platform overlay write is uncertain; reopen and reconcile"); }
    return record;
  };
  const serial = <T>(call: () => Promise<T>) => {
    const result = pending.then(async () => { if (failed) throw new Error("platform overlay storage requires reopen"); return call(); });
    pending = result.then(() => undefined, () => undefined); return result;
  };
  const observe = async (state: Allocation) => {
    const started = ports.now();
    if (!Number.isSafeInteger(started) || started < state.createdAt) return err("platform overlay clock is unavailable");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const observed = await Promise.race([
        Promise.resolve().then(() => ports.native.observe(state.action.scope)).catch(() => undefined),
        new Promise<undefined>((resolve) => { timer = setTimeout(() => { resolve(undefined); }, 10000); }),
      ]);
      const finished = ports.now();
      if (!Number.isSafeInteger(finished) || finished < started || finished - started >= 10000 || observed?.status !== "owned") return err("platform overlay evidence is unavailable");
      const grant = parseAppOverlayGrant(observed.grant);
      return grant.ok && same(grant.value.scope, state.action.scope) && (state.grant === null || same(state.grant, grant.value)) ? grant : err("platform overlay identity changed");
    } finally { if (timer !== undefined) clearTimeout(timer); }
  };
  const provision = (reference: RegistrationOwnership, scope: AppOverlayScope) => serial(async () => {
    const owner = parseRegistrationOwnership(reference); const target = parseAppOverlayScope(scope);
    if (!owner.ok || !target.ok || owner.value.registration.app !== target.value.app || owner.value.registration.incarnation !== target.value.incarnation) return err("platform overlay scope disagrees");
    let raw: unknown;
    try { raw = await ports.storage.read(); } catch { failed = true; throw new Error("platform overlay storage is unavailable"); }
    let state = raw === undefined ? undefined : parse(raw);
    if (raw !== undefined && state === undefined) { failed = true; throw new Error("platform overlay state is invalid; intervention required"); }
    if (state !== undefined && (!same(state.registration, owner.value) || !same(state.action.scope, target.value))) return err("platform overlay allocation scope changed");
    if (state === undefined) {
      const createdAt = ports.now();
      const action = appOverlayActionSchema.safeParse({ scope: target.value, operation: ports.newId(), deadline: createdAt + 90000 });
      if (!Number.isSafeInteger(createdAt) || createdAt < 0 || !action.success) return err("platform overlay intent is invalid");
      state = await save(Object.freeze({ version: 1, registration: owner.value, createdAt, action: action.data, grant: null }));
    }
    if (state.grant !== null || ports.now() >= state.action.deadline) {
      // Fresh read authority does not renew the persisted effect deadline or permit recreation.
      const found = await observe(state); if (!found.ok) return found;
      if (state.grant === null) await save(Object.freeze({ ...state, grant: found.value }));
      return found;
    }
    const expected = state.registration;
    const native: AppOverlayPort = Object.freeze({ observe: ports.native.observe, create: async (action) =>
      await ports.authorize(expected) ? ports.native.create(action) : "refused" });
    const result = await provisionAppOverlay(state.action, null, native, ports.now);
    if (!result.ok) return result;
    await save(Object.freeze({ ...state, grant: result.value }));
    return ok(result.value);
  });
  return Object.freeze({ provision, settle: () => pending });
};
