import { createHash } from "node:crypto";
import type { ManagedPlanPort } from "../../contracts/managed-plan.ts";
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
import { typed } from "../../lib/typed.ts";

type Scope = Omit<Parameters<typeof compileManagedApplicationPlan>[0], "volumes" | "images">;
type Input = { readonly scope: Scope; readonly artifact: Parameters<typeof compileManagedApplicationPlan>[1]; readonly description: Parameters<typeof compileManagedApplicationPlan>[2] };
type Ports = { readonly read: (registration: RegistrationGeneration, commit: string, artifact: string) => Promise<Input>; readonly images: ImageResolutionPort };

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
export const platformManagedPlans = (paths: { readonly publicRegistrations: string; readonly privateRegistrations: string; readonly swarmAuthority: string; readonly migrationPolicy: string; readonly domain: string },
  ports: { readonly read: (artifact: string) => Promise<string>; readonly images: ImageResolutionPort }) => managedPlans({ images: ports.images,
  read: async (registration, commit, artifact) => {
    const full = sha(commit); const app = appName(registration.app); if (!full.ok || !app.ok) throw new Error("managed compilation identity unavailable");
    const snapshot = await readPublicRegistrationGeneration(paths.publicRegistrations, registration); const current = await readPublicRegistration(paths.publicRegistrations, app.value);
    if (!snapshot.ok || !current.ok || snapshot.value.app.runtime !== "swarm" || JSON.stringify(current.value.metadata) !== JSON.stringify(registration)) throw new Error("managed compilation registration unavailable");
    const bytes = await ports.read(artifact); if (createHash("sha256").update(bytes).digest("hex") !== artifact) throw new Error("managed compilation artifact integrity failed");
    const payload: unknown = JSON.parse(bytes); const bundle = parseBundle(app.value, full.value, payload, registration, "artifact");
    if (!bundle.ok || bundle.value.rollout === undefined) throw new Error("managed compilation bundle unavailable");
    const description = describeManagedCompose(bundle.value.compose); if (!description.ok) throw new Error(description.error);
    const host = await readSwarmAuthority(paths.swarmAuthority); if (!host.ok) throw new Error("managed compilation host unavailable");
    const infrastructure = await readRegistrationInfrastructure(paths.publicRegistrations, registration, host.value);
    const configuration = await readPrivateConfiguration(paths.privateRegistrations, registration, 1000); const policy = await readMigrationPolicy(paths.migrationPolicy);
    if (!infrastructure.ok || !configuration.ok || !policy.ok) throw new Error("managed compilation platform inputs unavailable");
    return typed<Input>({ scope: { registration, runtime: "swarm", app: snapshot.value.app, authority: host.value, infrastructure: infrastructure.value,
      domain: paths.domain, configuration: { identity: configuration.value.identity, keys: Object.freeze(Object.keys(configuration.value.configuration)) },
      capabilities: ["rolling-http", "workers", "singleton", "retained-dependency", "migrations", "checks", "maintenance"], migrationTimeoutCeilingSeconds: policy.value.migrationTimeoutCeilingSeconds,
    }, artifact: { ...bundle.value, registration: bundle.value.registration, rollout: bundle.value.rollout, artifact }, description: description.value });
  },
});
