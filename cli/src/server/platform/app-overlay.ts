import { appOverlayActionSchema, parseAppOverlayGrant } from "../../contracts/app-overlay.ts";
import type { AppOverlayAction, AppOverlayGrant, AppOverlayPort } from "../../contracts/app-overlay.ts";
import { parseRegistrationGeneration } from "../../contracts/registration-generation.ts";
import type { RegistrationGeneration } from "../../contracts/registration-generation.ts";
import { parseSwarmAuthority } from "../../contracts/swarm-authority.ts";
import type { SwarmAuthority } from "../../contracts/swarm-authority.ts";
import type { Runtime } from "../../contracts/rollout.ts";
import { err, ok } from "../../lib/result.ts";

/** Runtime selection and host policy are operator inputs, never app Compose network names. */
export const appOverlayRequest = (registration: RegistrationGeneration, runtime: Runtime, host: SwarmAuthority, operation: string, deadline: number) => {
  const identity = parseRegistrationGeneration(registration); const authority = parseSwarmAuthority(host);
  if (runtime !== "swarm" || !identity.ok || !authority.ok) return err("app overlays require an explicitly selected Swarm registration and host");
  const request = appOverlayActionSchema.safeParse({ scope: { version: 1, app: identity.value.app, incarnation: identity.value.incarnation,
    node: authority.value.node, cluster: authority.value.cluster, name: `kayra-app-${identity.value.incarnation}` }, operation, deadline });
  return request.success ? ok<AppOverlayAction>(request.data) : err("invalid app overlay request");
};

/** A stored grant pins its physical ID. Missing or replaced infrastructure is never silently recreated. */
export const provisionAppOverlay = async (input: AppOverlayAction, stored: AppOverlayGrant | null, native: AppOverlayPort, now: () => number = Date.now) => {
  const checked = appOverlayActionSchema.safeParse(input); if (!checked.success) return err("invalid app overlay request"); const action = checked.data;
  const expected = stored === null ? null : parseAppOverlayGrant(stored);
  if (expected !== null && (!expected.ok || JSON.stringify(expected.value.scope) !== JSON.stringify(action.scope))) return err("app overlay grant scope changed");
  const grant = (input: AppOverlayGrant) => {
    const actual = parseAppOverlayGrant(input);
    return actual.ok && JSON.stringify(actual.value.scope) === JSON.stringify(action.scope) ? actual : err("app overlay observation has the wrong scope");
  };
  const started = now(); const remaining = action.deadline - started;
  if (!Number.isSafeInteger(started) || started < 0 || !Number.isSafeInteger(remaining) || remaining <= 0 || remaining > 90000) return err("app overlay deadline is unavailable or expired");
  // eslint-disable-next-line functional/no-let -- one elapsed-time bound covers the entire provisioning attempt
  let expired = false;
  // eslint-disable-next-line functional/no-let -- the timer is cleared when the provisioning attempt returns
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<undefined>((resolve) => { timer = setTimeout(() => { expired = true; resolve(undefined); }, remaining); });
  const live = () => { const time = now(); return !expired && Number.isSafeInteger(time) && time >= started && time < action.deadline; };
  const bounded = async <T>(call: () => Promise<T>) => {
    if (!live()) return undefined;
    const value = await Promise.race([Promise.resolve().then(() => live() ? call() : undefined).catch(() => undefined), expiry]);
    return live() ? value : undefined;
  };
  try {
    const before = await bounded(() => native.observe(action.scope));
    if (before === undefined) return err("app overlay evidence is unavailable");
    if (before.status === "owned") {
      const actual = grant(before.grant); if (!actual.ok) return actual;
      return expected !== null && expected.value.id !== actual.value.id ? err("app overlay identity changed") : actual;
    }
    if (stored !== null) return err(before.status === "absent" ? "recorded app overlay is missing" : "app overlay evidence is unavailable or conflicts");
    if (before.status !== "absent") return err("app overlay evidence is unavailable or conflicts");
    const effect = await bounded(() => native.create(action));
    if (effect !== "acknowledged" && effect !== "uncertain") return err("app overlay creation was refused or remains unresolved");
    // Swarm acknowledges network creation before all allocation metadata necessarily settles.
    while (live()) {
      const observed = await bounded(() => native.observe(action.scope));
      if (observed?.status === "owned") return grant(observed.grant);
      if (observed?.status === "ambiguous") return err("app overlay creation is ambiguous");
      const remaining = action.deadline - now(); if (remaining <= 0 || observed === undefined) break;
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(100, remaining)));
    }
    return err("app overlay creation remains unresolved");
  } catch { return err("app overlay evidence is unavailable"); }
  finally { if (timer !== undefined) clearTimeout(timer); }

};
