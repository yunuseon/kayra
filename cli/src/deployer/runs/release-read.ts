import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AppName } from "../../contracts/identity.ts";
import type { LegacyReleases } from "../../contracts/reporting.ts";
import { typed } from "../../lib/typed.ts";
import { releases } from "./records.ts";

/** Publish legacy filename facts without treating the newest record as verified active. */
export const legacyReleases = (platformDir: string, app: AppName) => {
  const dir = join(platformDir, "releases", app);
  const names = existsSync(dir) ? readdirSync(dir) : [];
  return typed<LegacyReleases>({ hasEntries: names.length > 0, releases: releases(names) });
};
