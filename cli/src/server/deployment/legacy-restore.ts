import type { AppName, Sha } from "../../contracts/identity.ts";

/** A registered app and the newest legacy release record, if one exists. */
export type Deployed = { readonly app: AppName; readonly live: Sha | undefined };

/**
 * Preserve the Compose restart rule: redeploy the newest legacy release when
 * no project container is observed. The record is not a verified active
 * release, and this decision does not recover an interrupted deployment.
 */
export const toRestore = (apps: readonly Deployed[], running: (app: AppName) => boolean) =>
  Object.freeze(apps.flatMap((each) => (each.live !== undefined && !running(each.app) ? Object.freeze([{ app: each.app, live: each.live } as const]) : Object.freeze([]))));
