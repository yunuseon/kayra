/* eslint-disable functional/no-let -- owns the experimental registration journal across control requests */
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { registrationObservation } from "../server/platform/registration-observation.ts";
import { createLifecycleAppIndex, openLifecycleAppIndex } from "../server/deployment/lifecycle-app-index.ts";
import { registrationControl } from "../server/deployment/registration-control.ts";

const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

/** Optional composition for the existing deployer control listener. */
export const startRegistrationControl = async (platform: string, observations: string) => {
  const path = join(platform, "lifecycle", "app-index");
  const observer = registrationObservation(observations);
  const present = await lstat(path).catch((error: unknown) => {
    if (missing(error)) return undefined;
    throw error;
  });
  let opening = present === undefined ? undefined : Promise.resolve(await openLifecycleAppIndex(path, observer));
  const canRegister = async (app: string) => {
    const claim = await lstat(join(platform, "managed-apps", app + ".json"));
    return claim.isFile() && claim.uid === 0 && claim.gid === 0 && (claim.mode & 0o7777) === 0o444 && claim.nlink === 1;
  };
  return Object.freeze({
    handle: async (route: string, input: unknown) => {
      if (route === "/registration/initialize") {
        if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).length !== 0) return undefined;
        // Only this explicit local control request can provision an empty index.
        opening ??= createLifecycleAppIndex(path, observer);
        await opening;
        return Object.freeze({ status: "ready" });
      }
      if (opening === undefined) throw new Error("registration index is not initialized");
      return registrationControl(await opening, canRegister)(route, input);
    },
    close: async () => {
      const index = await opening;
      await index?.close();
    },
  });
};
