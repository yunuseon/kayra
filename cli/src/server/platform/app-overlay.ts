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
export const provisionAppOverlay = async (input: AppOverlayAction, stored: AppOverlayGrant | null, native: AppOverlayPort) => {
  const checked = appOverlayActionSchema.safeParse(input); if (!checked.success) return err("invalid app overlay request"); const action = checked.data;
  const expected = stored === null ? null : parseAppOverlayGrant(stored);
  if (expected !== null && (!expected.ok || JSON.stringify(expected.value.scope) !== JSON.stringify(action.scope))) return err("app overlay grant scope changed");
  const grant = (input: AppOverlayGrant) => {
    const actual = parseAppOverlayGrant(input);
    return actual.ok && JSON.stringify(actual.value.scope) === JSON.stringify(action.scope) ? actual : err("app overlay observation has the wrong scope");
  };
  try {
    const before = await native.observe(action.scope);
    if (before.status === "owned") {
      const actual = grant(before.grant); if (!actual.ok) return actual;
      return expected !== null && expected.value.id !== actual.value.id ? err("app overlay identity changed") : actual;
    }
    if (stored !== null) return err(before.status === "absent" ? "recorded app overlay is missing" : "app overlay evidence is unavailable or conflicts");
    if (before.status !== "absent") return err("app overlay evidence is unavailable or conflicts");
    const effect = await native.create(action);
    if (effect !== "acknowledged" && effect !== "uncertain") return err("app overlay creation was refused or conflicts");
    const observed = await native.observe(action.scope);
    return observed.status === "owned" ? grant(observed.grant) : err("app overlay creation remains unresolved");
  } catch { return err("app overlay evidence is unavailable"); }
};
