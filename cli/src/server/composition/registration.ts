import { readMigrationPolicy } from "../platform/migration-policy.ts";
import { compileRolloutPlan } from "../deployment/rollout-plan.ts";
/* eslint-disable functional/no-let -- owns the experimental registration journal across control requests */
import { startHttpController } from "./http-controller.ts";
import { httpEnvironment } from "../platform/http-environment.ts";
import { routedReadiness } from "../platform/routed-readiness.ts";
import { swarmRouting } from "../platform/swarm-routing.ts";
import { dockerApi } from "../runtime/docker-api.ts";
import { startRolloutController } from "./rollout-controller.ts";
import { oneShotJob, oneShotCleanup } from "../runtime/one-shot-job.ts";
import { observeSwarmHost } from "../runtime/swarm-host.ts";
import { swarmService } from "../runtime/swarm-service.ts";
import { describeCompose } from "../runtime/compose-description.ts";
import { compileHttpPlan } from "../deployment/http-plan.ts";
import { readPrivateConfiguration } from "../platform/private-registration.ts";
import type { RegistrationGeneration } from "../../contracts/registration-generation.ts";
import type { Runtime } from "../../contracts/rollout.ts";
import { readSwarmAuthority } from "../platform/swarm-authority.ts";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import { readPublicRegistrationGeneration } from "../platform/public-registration.ts";
import { openArtifactStore } from "../deployment/artifact-store.ts";
import { builderPrepare } from "../../deployer/build/client.ts";
import { parseBundle, bundleWire } from "../../deployer/build/bundle.ts";
import { appName, sha, type Sha } from "../../deployer/brand.ts";
import { registrationObservation } from "../platform/registration-observation.ts";
import { createLifecycleAppIndex, openLifecycleAppIndex } from "../deployment/lifecycle-app-index.ts";
import { deploymentControl } from "../deployment/deployment-control.ts";
import { registrationControl } from "../deployment/registration-control.ts";

const missing = (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";

const parseBundleRegistration = (registration: RegistrationGeneration, commit: Sha, payload: unknown) => {
  const app = appName(registration.app);
  return app.ok ? parseBundle(app.value, commit, payload, registration, "artifact") : undefined;
};

/** Optional composition for the existing deployer control listener. */
export type RegistrationComposition = {
  readonly platformDirectory: string;
  readonly registrationObservations: string;
  readonly publicRegistrations?: string | undefined;
  readonly builderUrl?: string | undefined;
  readonly migrationPolicy?: string | undefined;
  readonly swarmAuthority?: string | undefined;
  readonly privateRegistrations?: string | undefined;
  readonly domain?: string | undefined;
};
export const startRegistrationControl = async ({ platformDirectory: platform, registrationObservations: observations,
  publicRegistrations, builderUrl: builder = "http://builder:8081", swarmAuthority, migrationPolicy, privateRegistrations, domain = "localhost" }: RegistrationComposition) => {
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
    images: (content: string, registration: RegistrationGeneration, commit: string) => {
      const fullCommit = sha(commit);
      const snapshot: unknown = JSON.parse(content);
      // The expected identity comes from the journal, never the retained payload.
      const app = fullCommit.ok ? parseBundleRegistration(registration, fullCommit.value, snapshot) : undefined;
      if (!app?.ok) throw new Error("retained bundle does not match build intent");
      return Object.freeze(app.value.images.map((image) => image.ref));
    },
    // eslint-disable-next-line functional/prefer-immutable-types -- AbortSignal is an externally owned cancellation notification
    prepare: async (registration: RegistrationGeneration, commit: string, deadline: number, signal: AbortSignal, runtime: Runtime) => {
      const snapshot = await readPublicRegistrationGeneration(publicRegistrations, registration);
      const fullCommit = sha(commit);
      if (!snapshot.ok || !fullCommit.ok || snapshot.value.app.runtime !== runtime) throw new Error("build registration or commit is invalid");
      const prepared = await builderPrepare(builder, snapshot.value.app, fullCommit.value, console.log, registration, deadline, signal);
      if (!prepared.ok) throw new Error("builder did not prepare the registered commit");
      const checked = parseBundle(snapshot.value.app.name, fullCommit.value, prepared.value, registration, "artifact");
      if (!checked.ok || (runtime === "swarm" && checked.value.rollout === undefined)) throw new Error("builder returned an invalid or incomplete artifact");
      return JSON.stringify(bundleWire(checked.value));
    },
  });
  const proposals = artifacts === undefined || publicRegistrations === undefined || privateRegistrations === undefined || swarmAuthority === undefined ? undefined : Object.freeze({
    read: async (registration: RegistrationGeneration, runtime: Runtime, commit: string, artifact: string) => {
      const snapshot = await readPublicRegistrationGeneration(publicRegistrations, registration);
      const fullCommit = sha(commit);
      if (!snapshot.ok || !fullCommit.ok || snapshot.value.app.runtime !== runtime) throw new Error("plan registration or commit is invalid");
      const payload: unknown = JSON.parse(await artifacts.read(artifact));
      const checked = parseBundleRegistration(registration, fullCommit.value, payload);
      if (!checked?.ok) throw new Error("retained artifact does not match plan scope");
      const authority = await readSwarmAuthority(swarmAuthority);
      const configuration = await readPrivateConfiguration(privateRegistrations, registration, 1000);
      if (!authority.ok || !configuration.ok) throw new Error("platform plan inputs are unavailable");
      const description = describeCompose(checked.value.compose);
      if (!description.ok) throw new Error(description.error);
      return Object.freeze({ scope: Object.freeze({ registration, runtime, app: snapshot.value.app, authority: authority.value, domain,
        configuration: Object.freeze({ identity: configuration.value.identity, keys: Object.freeze(Object.keys(configuration.value.configuration)) }) }),
        artifact: Object.freeze({ ...checked.value, registration: checked.value.registration, rollout: checked.value.rollout, artifact }), description: description.value });
    },
  });
  const plans = proposals === undefined ? undefined : Object.freeze({
    preview: async (...args: Readonly<Parameters<typeof proposals.read>>) => {
      const input = await proposals.read(...args); const compiled = compileHttpPlan(input.scope, input.artifact, input.description);
      if (!compiled.ok) throw new Error(compiled.error); return compiled.value;
    },
  });
  const rollouts = proposals === undefined || migrationPolicy === undefined ? undefined : Object.freeze({
    preview: async (...args: Readonly<Parameters<typeof proposals.read>>) => {
      const policy = await readMigrationPolicy(migrationPolicy); if (!policy.ok) throw new Error(policy.error);
      const input = await proposals.read(...args); const compiled = compileRolloutPlan(input.scope, input.artifact, input.description, policy.value.migrationTimeoutCeilingSeconds);
      if (!compiled.ok) throw new Error(compiled.error); return compiled.value;
    },
  });
  const api = dockerApi();
  const executionPorts = artifacts === undefined || publicRegistrations === undefined || privateRegistrations === undefined || swarmAuthority === undefined ? undefined : Object.freeze({
    ...artifacts, ...httpEnvironment(publicRegistrations, privateRegistrations, 1000), now: Date.now,
    observeHost: (host: Parameters<typeof observeSwarmHost>[0]) => observeSwarmHost(host, api),
    native: swarmService(api), routing: swarmRouting, readiness: routedReadiness(),
  });
  let controller: ReturnType<typeof startHttpController> | undefined;
  let rolloutController: ReturnType<typeof startRolloutController> | undefined;
  let lastReport = "";
  const startController = (index: Parameters<typeof startHttpController>[0] & Parameters<typeof startRolloutController>[0]) => {
    if (controller !== undefined || executionPorts === undefined) return;
    rolloutController = startRolloutController(index, { ...executionPorts, jobs: oneShotJob(api), cleanup: oneShotCleanup(api) }, (result) => {
      if (result.status !== "ready" || result.work.length > 0) console.log("rollout-coordinator: " + JSON.stringify(result));
    });
    controller = startHttpController(index, executionPorts, (result) => {
      const content = JSON.stringify(result);
      if (content !== lastReport && (result.status !== "ready" || result.work.length > 0)) console.log("http-coordinator: " + content);
      lastReport = content;
    });
  };
  if (opening !== undefined) startController(await opening);
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
        startController(await opening);
        return Object.freeze({ status: "ready" });
      }
      if (opening === undefined) throw new Error("registration index is not initialized");
      if (route.startsWith("/deployment/")) return deploymentControl({ index: await opening, canAccess: canRegister, now: Date.now,
        enabled: async () => swarmAuthority !== undefined && (await readSwarmAuthority(swarmAuthority)).ok,
        plans: plans === undefined || artifacts === undefined ? undefined : { ...plans, now: Date.now, retain: artifacts.retain },
        rollouts: rollouts === undefined || artifacts === undefined ? undefined : { ...rollouts, now: Date.now, retain: artifacts.retain },
        recovery: artifacts === undefined ? undefined : { actor: { kind: "operator-control", identity: "local-control:uid:" + String(process.getuid?.() ?? "unknown") },
          ports: { read: artifacts.read, now: Date.now, native: oneShotJob(api) } },
      })(route, input);
      return registrationControl({ index: await opening, canRegister, builds, plans, rollouts,
        runtimeEnabled: async (runtime) => runtime === "compose" || (swarmAuthority !== undefined && (await readSwarmAuthority(swarmAuthority)).ok),
      })(route, input);
    },
    close: async () => {
      await controller?.close();
      await rolloutController?.close();
      const index = await opening;
      await index?.close();
    },
  });
};
