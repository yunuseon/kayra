import { createHash } from "node:crypto";
import type { ManagedPlanPort, ManagedRecreationPlanPort } from "../../contracts/managed-plan.ts";
import type { RegistrationGeneration } from "../../contracts/registration-generation.ts";
import type { ImageResolutionPort } from "../../contracts/image-admission.ts";
import { sha, appName } from "../../deployer/brand.ts";
import { parseBundle } from "../../deployer/build/bundle.ts";
import { compileManagedApplicationPlan, managedImageDeclarations } from "../deployment/managed-application-plan.ts";
import { describeManagedCompose } from "../runtime/managed-compose-description.ts";
import { readPublicRegistration, readPublicRegistrationGeneration } from "../platform/public-registration.ts";
import { readRegistrationInfrastructure } from "../platform/registration-infrastructure.ts";
import { readPrivateConfiguration } from "../platform/private-registration.ts";
import { readMigrationPolicy } from "../platform/migration-policy.ts";
import { readSwarmAuthority } from "../platform/swarm-authority.ts";
import { recreatedManagedPlan } from "../deployment/managed-recreation-plan.ts";
import { platformRecreatedInputs } from "../platform/service-inputs.ts";
import { typed } from "../../lib/typed.ts";

type Scope = Omit<Parameters<typeof compileManagedApplicationPlan>[0], "volumes" | "images">;
type Input = { readonly scope: Scope; readonly artifact: Parameters<typeof compileManagedApplicationPlan>[1]; readonly description: Parameters<typeof compileManagedApplicationPlan>[2] };
type Ports = { readonly read: (registration: RegistrationGeneration, commit: string, artifact: string) => Promise<Input>; readonly images: ImageResolutionPort };
type PlatformPaths = { readonly publicRegistrations: string; readonly privateRegistrations: string; readonly swarmAuthority: string; readonly migrationPolicy: string; readonly domain: string };
type PlatformPorts = { readonly read: (artifact: string) => Promise<string>; readonly images: ImageResolutionPort };

const retainedBundle = async (read: PlatformPorts["read"], registration: RegistrationGeneration, commit: string, artifact: string) => {
  const full = sha(commit); const app = appName(registration.app);
  if (!full.ok || !app.ok) throw new Error("managed compilation identity unavailable");
  const bytes = await read(artifact);
  if (createHash("sha256").update(bytes).digest("hex") !== artifact) throw new Error("managed compilation artifact integrity failed");
  const raw: unknown = JSON.parse(bytes);
  const bundle = parseBundle(app.value, full.value, raw, registration, "artifact");
  if (!bundle.ok || bundle.value.rollout === undefined || bundle.value.registration === undefined) throw new Error("managed compilation bundle unavailable");
  const description = describeManagedCompose(bundle.value.compose);
  if (!description.ok) throw new Error(description.error);
  return Object.freeze({ artifact: Object.freeze({ ...bundle.value, registration: bundle.value.registration, rollout: bundle.value.rollout, artifact }), description: description.value });
};

/** Trusted wiring only: app descriptions do not select platform infrastructure or authorize native writes. */
export const managedPlans = (ports: Ports) => {
  const read = async (registration: RegistrationGeneration, commit: string, artifact: string) => {
    const input = await ports.read(registration, commit, artifact);
    if (input.artifact.sha !== commit || input.artifact.artifact !== artifact || JSON.stringify(input.scope.registration) !== JSON.stringify(registration) || JSON.stringify(input.artifact.registration) !== JSON.stringify(registration)) throw new Error("managed compilation input identity disagrees");
    return input;
  };
  return typed<ManagedPlanPort>(Object.freeze({
    volumeKeys: async (...args) => Object.freeze([...(await read(...args)).description.volumes]),
    preview: async (registration, commit, artifact, volumes) => {
      const input = await read(registration, commit, artifact); const declarations = managedImageDeclarations(input.artifact, input.description);
      if (!declarations.ok) throw new Error(declarations.error);
      const images = await ports.images.resolveDeclared(registration.app, declarations.value);
      if (images.status !== "accepted") throw new Error("managed image metadata is unavailable or unsupported");
      const plan = compileManagedApplicationPlan({ ...input.scope, volumes, images: images.images }, input.artifact, input.description);
      if (!plan.ok) throw new Error(plan.error); return plan.value;
    },
  }));
};

/** Reads exact immutable publications and revalidates the untrusted builder bundle; never opens secret files or deployment journals. */
export const platformManagedPlans = (paths: PlatformPaths, ports: PlatformPorts) => managedPlans({ images: ports.images,
  read: async (registration, commit, artifact) => {
    const full = sha(commit); const app = appName(registration.app); if (!full.ok || !app.ok) throw new Error("managed compilation identity unavailable");
    const snapshot = await readPublicRegistrationGeneration(paths.publicRegistrations, registration); const current = await readPublicRegistration(paths.publicRegistrations, app.value);
    if (!snapshot.ok || !current.ok || snapshot.value.app.runtime !== "swarm" || JSON.stringify(current.value.metadata) !== JSON.stringify(registration)) throw new Error("managed compilation registration unavailable");
    const retained = await retainedBundle(ports.read, registration, commit, artifact);
    const host = await readSwarmAuthority(paths.swarmAuthority); if (!host.ok) throw new Error("managed compilation host unavailable");
    const infrastructure = await readRegistrationInfrastructure(paths.publicRegistrations, registration, host.value);
    const configuration = await readPrivateConfiguration(paths.privateRegistrations, registration, 1000); const policy = await readMigrationPolicy(paths.migrationPolicy);
    if (!infrastructure.ok || !configuration.ok || !policy.ok) throw new Error("managed compilation platform inputs unavailable");
    return typed<Input>({ scope: { registration, runtime: "swarm", app: snapshot.value.app, authority: host.value, infrastructure: infrastructure.value,
      domain: paths.domain, configuration: { identity: configuration.value.identity, keys: Object.freeze(Object.keys(configuration.value.configuration)) },
      capabilities: ["rolling-http", "workers", "singleton", "retained-dependency", "migrations", "checks", "maintenance"], migrationTimeoutCeilingSeconds: policy.value.migrationTimeoutCeilingSeconds,
    }, ...retained });
  },
});

export const platformManagedRecreationPlan = (paths: PlatformPaths, ports: PlatformPorts) => {
  const inputs = platformRecreatedInputs(paths.publicRegistrations, paths.privateRegistrations, 1000);
  return typed<ManagedRecreationPlanPort>(Object.freeze({
    rebind: async (verified, registration) => {
      const app = appName(registration.app);
      if (!app.ok) throw new Error("managed recreation app identity unavailable");
      const [current, host, configuration, policy, retained] = await Promise.all([
        readPublicRegistration(paths.publicRegistrations, app.value), readSwarmAuthority(paths.swarmAuthority),
        readPrivateConfiguration(paths.privateRegistrations, registration, 1000), readMigrationPolicy(paths.migrationPolicy),
        retainedBundle(ports.read, verified.infrastructure.registration, verified.commit, verified.artifact),
      ]);
      if (!current.ok || current.value.app.runtime !== "swarm" || JSON.stringify(current.value.metadata) !== JSON.stringify(registration) ||
        !host.ok || !configuration.ok || !policy.ok) throw new Error("managed recreation platform inputs unavailable");
      const infrastructure = await readRegistrationInfrastructure(paths.publicRegistrations, registration, host.value);
      if (!infrastructure.ok) throw new Error(infrastructure.error);
      const declarations = managedImageDeclarations(retained.artifact, retained.description);
      if (!declarations.ok) throw new Error(declarations.error);
      const images = await ports.images.resolveDeclared(registration.app, declarations.value);
      if (images.status !== "accepted" || images.images.length !== verified.images.length ||
        images.images.some((image) => !verified.images.some((old) => JSON.stringify(old) === JSON.stringify(image)))) {
        throw new Error("managed recreation requires every verified image digest");
      }
      const rebound = recreatedManagedPlan(verified, {
        infrastructure: infrastructure.value, host: host.value, grants: current.value.app.grants,
        hosts: current.value.app.hosts, secrets: current.value.app.secrets, configurationIdentity: configuration.value.identity,
        policy: { ...verified.policy, migrationTimeoutCeilingSeconds: policy.value.migrationTimeoutCeilingSeconds },
      });
      if (!rebound.ok) throw new Error(rebound.error);
      const comparisons = await Promise.all(Object.entries(verified.services).map(async ([name, previous]) => {
        const service = rebound.value.services[name];
        return service === undefined ? "unavailable" : inputs.compareRecreated(previous.inputs, service.inputs);
      }));
      if (comparisons.some((comparison) => comparison !== "unchanged")) throw new Error("managed recreation workload inputs changed or are unavailable");
      return rebound.value;
    },
  }));
};
