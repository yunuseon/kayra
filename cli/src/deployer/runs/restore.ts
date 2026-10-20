import type { AppName, Sha } from "../brand.ts";

/** A registered app, and the release that ran last, if it was ever deployed. */
export type Deployed = { readonly app: AppName; readonly live: Sha | undefined };

/**
 * The apps to deploy again as they were: deployed once, yet no container of
 * theirs running now — after a Docker update, a reboot, or anything else that
 * stopped them without kayra.
 */
export const toRestore = (apps: readonly Deployed[], running: (app: AppName) => boolean) =>
  Object.freeze(apps.flatMap((each) => (each.live !== undefined && !running(each.app) ? Object.freeze([{ app: each.app, live: each.live } as const]) : Object.freeze([]))));
