import { parseImageDeclarations, parseOwnedImageReference } from "../../contracts/image-admission.ts";
import type { ManagedComposeDescription } from "../../contracts/managed-compose-description.ts";
import type { HttpArtifact, HttpPlanScope } from "../../contracts/http-plan.ts";
import type { RegistrationInfrastructure } from "../../contracts/registration-infrastructure.ts";
import type { OwnedVolume } from "../../contracts/owned-volume.ts";
import type { ResolvedImage } from "../../contracts/image-admission.ts";
import type { Capability } from "../../contracts/rollout.ts";
import { matchRegistrationGeneration } from "../../contracts/registration-generation.ts";
import { parseManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import { managedServiceName } from "../../contracts/managed-service-plan.ts";
import { parseRollout, validateAdmission } from "../../contracts/rollout.ts";
import { all, err, ok } from "../../lib/result.ts";
import { environmentBindings } from "./environment-bindings.ts";

type Scope = HttpPlanScope & {
  readonly infrastructure: RegistrationInfrastructure;
  readonly volumes: readonly OwnedVolume[];
  readonly images: readonly ResolvedImage[];
  readonly capabilities: readonly Capability[];
  readonly migrationTimeoutCeilingSeconds: number;
};

const imageSource = (artifact: HttpArtifact, image: string) => {
  const variable = /^\$\{([A-Z][A-Z0-9_]*_IMAGE)(?::\?[^}]*)?\}$/.exec(image);
  return variable?.[1] === undefined ? artifact.images.find((item) => item.ref === image)?.ref : artifact.images.find((item) => item.variable === variable[1])?.ref;
};

/** Derive every inspection context from validated service and migration declarations; a service's mount coverage never authorizes a one-shot. */
export const managedImageDeclarations = (artifact: HttpArtifact, description: ManagedComposeDescription) => {
  const rollout = parseRollout(artifact.rollout); if (!rollout.ok) return rollout;
  const services = all(Object.values(description.services).map((service) => {
    const image = imageSource(artifact, service.image);
    return image === undefined ? err("managed service image is outside the artifact") : ok(Object.freeze({ image, kind: "service", volumeTargets: Object.freeze(service.mounts.map((mount) => mount.target)) }));
  }));
  const migrations = all(rollout.value.migrations.map((step) => {
    const service = description.services[step.service]; const image = service === undefined ? undefined : imageSource(artifact, service.image);
    return image === undefined ? err("managed migration image is outside the description") : ok(Object.freeze({ image, kind: "one-shot", volumeTargets: Object.freeze([]) }));
  }));
  return services.ok && migrations.ok ? parseImageDeclarations([...services.value, ...migrations.value]) : err("managed image declarations are incomplete");
};

/** Pure compilation. All operator inputs, registry resolutions and durable allocation identities come from trusted ports, never app-selected infrastructure. */
export const compileManagedApplicationPlan = (scope: Scope, artifact: HttpArtifact, description: ManagedComposeDescription) => {
  if (scope.runtime !== "swarm" || scope.app.runtime !== "swarm" || scope.app.name !== scope.registration.app ||
    !matchRegistrationGeneration(artifact.registration, scope.registration, scope.registration).ok || !matchRegistrationGeneration(scope.infrastructure.registration, scope.registration, scope.registration).ok) return err("managed artifact or infrastructure does not match its registration");
  if (Object.keys(description).some((key) => !["services", "volumes"].includes(key)) || Object.values(description.services).some((service) => Object.keys(service).some((key) => !["image", "environment", "command", "entrypoint", "resources", "health", "stopGraceSeconds", "mounts", "dependencies"].includes(key)))) return err("unsupported managed Compose description fields");
  const rollout = parseRollout(artifact.rollout); if (!rollout.ok) return rollout;
  const declarations = managedImageDeclarations(artifact, description); if (!declarations.ok) return declarations;
  const usedImages = new Set(declarations.value.map((usage) => usage.image));
  const names = Object.keys(description.services);
  const admitted = validateAdmission({ runtime: scope.runtime, existingRuntime: scope.runtime, swarmEnabled: true, maintenanceGranted: scope.app.grants.maintenance,
    capabilities: scope.capabilities, rollout: rollout.value, composeServices: names, routedServices: artifact.routes.map((route) => route.service),
    migrationTimeoutCeilingSeconds: scope.migrationTimeoutCeilingSeconds, checkTimeoutCeilingSeconds: 90,
  });
  if (!admitted.ok) return admitted;
  const keys = scope.configuration.keys;
  if (keys.some((key) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(key)) || new Set(keys).size !== keys.length || keys.some((key) => scope.app.secrets.includes(key))) return err("invalid managed configuration declarations");
  const owned = scope.infrastructure.ownership;
  if (new Set(description.volumes).size !== description.volumes.length || new Set(scope.volumes.map((volume) => volume.key)).size !== scope.volumes.length ||
    scope.volumes.length !== description.volumes.length || scope.volumes.some((volume) => !description.volumes.includes(volume.key) || volume.app !== owned.app || volume.dataOwner !== owned.dataOwner)) return err("managed volume allocations do not match the description");
  if (new Set(artifact.images.map((image) => image.variable)).size !== artifact.images.length || artifact.images.some((image) => !/^[A-Z][A-Z0-9_]*_IMAGE$/.test(image.variable) || !parseOwnedImageReference(scope.app.name, image.ref).ok) ||
    new Set(scope.images.map((image) => image.source)).size !== scope.images.length || scope.images.length !== usedImages.size || scope.images.some((image) => !usedImages.has(image.source))) return err("managed image resolutions do not match the artifact");
  const services = all(names.map((name) => {
    const service = description.services[name]; const declaration = rollout.value.services[name];
    if (service === undefined || declaration === undefined) return err("managed service declaration is missing");
    const source = imageSource(artifact, service.image);
    const image = scope.images.find((resolved) => resolved.source === source)?.pull;
    if (image === undefined) return err("managed service image has no verified native resolution");
    const environment = environmentBindings(service.environment, keys, scope.app.secrets); if (!environment.ok) return environment;
    const mounts = all(service.mounts.map((mount) => {
      const volume = scope.volumes.find((item) => item.key === mount.volume);
      return volume === undefined ? err("managed volume allocation is missing") : ok(Object.freeze({ ...mount, volume }));
    })); if (!mounts.ok) return mounts;
    return ok(Object.freeze({ name, spec: Object.freeze({ version: 1, runtime: "swarm", owner: owned, service: name, nativeName: managedServiceName(owned, name), role: declaration.role, overlap: declaration.overlap,
      handoffCheck: declaration.handoff_check ?? null, image,
      inputs: Object.freeze({ version: 1, registration: scope.registration, configurationIdentity: scope.configuration.identity, environment: Object.freeze(Object.fromEntries(environment.value)) }),
      command: service.command, entrypoint: service.entrypoint, resources: service.resources, health: service.health, stopGraceSeconds: service.stopGraceSeconds,
      host: Object.freeze({ node: scope.authority.node, cluster: scope.authority.cluster, routingNetwork: declaration.role === "http" ? scope.authority.network.id : null }),
      privateNetwork: Object.freeze({ id: scope.infrastructure.overlay.id, name: scope.infrastructure.overlay.scope.name }), mounts: mounts.value, dependencies: service.dependencies,
    }) }));
  }));
  if (!services.ok) return services;
  if (description.volumes.some((key) => !Object.values(description.services).some((service) => service.mounts.some((mount) => mount.volume === key)))) return err("unused managed volume declaration");
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(scope.domain)) return err("invalid platform domain");
  return parseManagedApplicationPlan({ version: 3, runtime: "swarm", infrastructure: scope.infrastructure, commit: artifact.sha, artifact: artifact.artifact,
    host: scope.authority, grants: scope.app.grants, hosts: scope.app.hosts, configurationIdentity: scope.configuration.identity, rollout: rollout.value,
    policy: { version: 1, failureMonitorSeconds: 30, updateTimeoutSeconds: 90, rollbackTimeoutSeconds: 90, migrationTimeoutCeilingSeconds: scope.migrationTimeoutCeilingSeconds, checkTimeoutCeilingSeconds: 90 },
    images: scope.images, services: Object.fromEntries(services.value.map((item) => [item.name, item.spec] as const)),
    routes: artifact.routes.map((route) => Object.freeze({ host: `${route.host}.${scope.domain}`, service: route.service, port: route.port, path: route.path ?? null, check: route.check ?? route.path ?? "/", rateLimit: route.rateLimit ?? null })),
  });
};
