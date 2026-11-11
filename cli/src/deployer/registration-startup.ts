/* eslint-disable functional/no-let -- owns the experimental registration journal across control requests */
import type { RegistrationGeneration } from "../contracts/registration-generation.ts";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readPublicRegistrationGeneration } from "../server/platform/public-registration.ts";
import { openArtifactStore } from "../server/deployment/artifact-store.ts";
import { builderPrepare } from "./build/client.ts";
import { parseBundle, bundleWire } from "./build/bundle.ts";
import { sha } from "./brand.ts";
import { registrationObservation } from "../server/platform/registration-observation.ts";
import { createLifecycleAppIndex, openLifecycleAppIndex } from "../server/deployment/lifecycle-app-index.ts";
import { registrationControl } from "../server/deployment/registration-control.ts";

const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

/** Optional composition for the existing deployer control listener. */
export const startRegistrationControl = async (platform: string, observations: string, publicRegistrations?: string, builder = "http://builder:8081") => {
  const path = join(platform, "lifecycle", "app-index");
  const observer = registrationObservation(observations);
  const present = await lstat(path).catch((error: unknown) => {
    if (missing(error)) return undefined;
    throw error;
  });
  let opening = present === undefined ? undefined : Promise.resolve(await openLifecycleAppIndex(path, observer));
  const artifacts = publicRegistrations === undefined ? undefined : await openArtifactStore(join(platform, "lifecycle", "artifacts"));
  const builds = artifacts === undefined || publicRegistrations === undefined ? undefined : Object.freeze({
    now: Date.now,
    retain: artifacts.retain,
    read: artifacts.read,
// eslint-disable-next-line functional/prefer-immutable-types -- AbortSignal is an externally owned cancellation notification
    prepare: async (registration: RegistrationGeneration, commit: string, deadline: number, signal: AbortSignal) => {
      const snapshot = await readPublicRegistrationGeneration(publicRegistrations, registration);
      const fullCommit = sha(commit);
      if (!snapshot.ok || !fullCommit.ok) throw new Error("build registration or commit is invalid");
      const prepared = await builderPrepare(builder, snapshot.value.app, fullCommit.value, console.log, registration, deadline, signal);
      if (!prepared.ok) throw new Error("builder did not prepare the registered commit");
      const checked = parseBundle(snapshot.value.app.name, fullCommit.value, prepared.value, registration);
      if (!checked.ok) throw new Error("builder returned an invalid artifact");
      return JSON.stringify(bundleWire(checked.value));
    },
  });
  const canRegister = async (app: string) => {
    const claim = await lstat(join(platform, "managed-apps", app + ".json"));
    return claim.isFile() && claim.uid === 0 && claim.gid === 0 && (claim.mode & 0o7777) === 0o444 && claim.nlink === 1;
  };
  return Object.freeze({
    handle: async (route: string, input: unknown) => {
      if (route === "/registration/initialize") {
        if (typeof input !== "object" || input === null || Array.isArray(input) || Object.keys(input).length !== 0) return undefined;
        // Only this explicit local control request can provision an empty index.
        // eslint-disable-next-line functional/prefer-immutable-types -- returns the live journal owner
        opening ??= (async () => {
          const claims = await readdir(join(platform, "managed-apps"));
          if (claims.length !== 0) throw new Error("managed app claims exist without an index; intervention required");
          return createLifecycleAppIndex(path, observer);
        })();
        await opening;
        return Object.freeze({ status: "ready" });
      }
      if (opening === undefined) throw new Error("registration index is not initialized");
      return registrationControl(await opening, canRegister, builds)(route, input);
    },
    close: async () => {
      const index = await opening;
      await index?.close();
    },
  });
};
