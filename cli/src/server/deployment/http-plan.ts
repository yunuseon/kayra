import { matchRegistrationGeneration } from "../../contracts/registration-generation.ts";
import { admitSwarmGrants } from "../../contracts/swarm-authority.ts";
import { parseRollout, validateAdmission } from "../../contracts/rollout.ts";
import type { ComposeDescription } from "../../contracts/compose-description.ts";
import type { ApplicationPlan, EnvironmentBinding, HttpArtifact, HttpPlanScope } from "../../contracts/http-plan.ts";
import { all, err, ok } from "../../lib/result.ts";

const variable = /^[A-Z][A-Z0-9_]{0,127}$/;
const component = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const bindings = (environment: Readonly<Record<string, string>>, configuration: readonly string[], secrets: readonly string[]) => all(Object.entries(environment).map(([name, value]) => {
  const reference = /^\$\{([A-Z][A-Z0-9_]{0,127})(?::\?[^}]*)?\}$/.exec(value);
  if (reference?.[1] !== undefined) {
    const key = reference[1];
    if (configuration.includes(key)) return ok<readonly [string, EnvironmentBinding]>([name, Object.freeze({ kind: "configuration", key })]);
    if (secrets.includes(key)) return ok<readonly [string, EnvironmentBinding]>([name, Object.freeze({ kind: "secret", key })]);
    return err("environment references undeclared configuration or secret input");
  }
  const literal = value.replaceAll("$$", "\0");
  if (literal.includes("$")) return err("only literal environment values and exact declared input references are supported");
  return ok<readonly [string, EnvironmentBinding]>([name, Object.freeze({ kind: "literal", value: literal.replaceAll("\0", "$") })]);
}));

/** Compile a proposal from immutable inputs. Host admission and runtime effects remain separate. */
export const compileHttpPlan = (scope: HttpPlanScope, artifact: HttpArtifact, description: ComposeDescription) => {
  if (scope.runtime !== "swarm" || scope.app.runtime !== "swarm") return err("experimental HTTP requires the persisted Swarm runtime");
  if (scope.app.name !== scope.registration.app || !matchRegistrationGeneration(artifact.registration, scope.registration, scope.registration).ok ||
    !/^[0-9a-f]{40}$/.test(artifact.sha) || !/^[0-9a-f]{64}$/.test(artifact.artifact)) return err("artifact does not match the verified registration");
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(scope.domain) || !/^sha256:[0-9a-f]{64}$/.test(scope.configuration.identity)) return err("invalid platform domain or configuration identity");
  const configurationKeys = scope.configuration.keys;
  const secretKeys = scope.app.secrets;
  if (configurationKeys.some((key) => !variable.test(key)) || new Set(configurationKeys).size !== configurationKeys.length || secretKeys.some((key) => configurationKeys.includes(key))) return err("invalid configuration and secret key declarations");
  const grants = admitSwarmGrants(scope.authority, scope.app.grants);
  if (!grants.ok) return grants;
  const parsedRollout = parseRollout(artifact.rollout);
  if (!parsedRollout.ok) return err("Swarm requires valid explicit rollout metadata");
  const rollout = parsedRollout.value;
  const services = Object.keys(description.services);
  const admitted = validateAdmission({
    runtime: "swarm", swarmEnabled: true, maintenanceGranted: scope.app.grants.maintenance, existingRuntime: scope.runtime,
    capabilities: ["rolling-http"], rollout, composeServices: services, routedServices: artifact.routes.map((route) => route.service),
    migrationTimeoutCeilingSeconds: 90, checkTimeoutCeilingSeconds: 90,
  });
  if (!admitted.ok) return admitted;
  const name = services[0];
  if (services.length !== 1 || name === undefined || rollout.strategy !== "rolling" || rollout.services[name]?.role !== "http" || artifact.routes.length !== 1) return err("experimental HTTP currently supports one rolling HTTP service and one route");
  const service = description.services[name];
  const route = artifact.routes[0];
  if (service === undefined || route?.service !== name || `kayra-${scope.app.name}--${name}`.length > 63) return err("invalid HTTP service or routing identity");
  const host = `${route.host}.${scope.domain}`;
  if (!scope.app.hosts.includes(host)) return err("HTTP route is outside the registered host grants");
  const own = new RegExp(`^localhost:5000/${scope.app.name}/${component}(?:/${component})*@sha256:[0-9a-f]{64}$`);
  if (new Set(artifact.images.map((image) => image.variable)).size !== artifact.images.length || artifact.images.some((image) => !/^[A-Z][A-Z0-9_]*_IMAGE$/.test(image.variable) || !own.test(image.ref))) return err("artifact images must be unique app-owned digest references");
  const reference = /^\$\{([A-Z][A-Z0-9_]*_IMAGE)(?::\?[^}]*)?\}$/.exec(service.image);
  const image = reference?.[1] === undefined ? artifact.images.find((image) => image.ref === service.image)?.ref : artifact.images.find((image) => image.variable === reference[1])?.ref;
  if (image === undefined) return err("HTTP service image is not a verified artifact image");
  const resources = service.resources;
  const cpu = Math.ceil(resources.nanoCpus / 1_000_000);
  if (!Number.isSafeInteger(cpu) || resources.memoryBytes > scope.app.grants.memory_bytes || cpu > scope.app.grants.cpu_millicores) return err("service resources exceed application grants");
  const environment = bindings(service.environment, configurationKeys, secretKeys);
  if (!environment.ok) return environment;
  return ok<ApplicationPlan>(Object.freeze({
    version: 1, runtime: "swarm", app: scope.app.name, registration: Object.freeze({ ...scope.registration }), commit: artifact.sha, artifact: artifact.artifact,
    host: Object.freeze({ ...scope.authority, profile: Object.freeze({ ...scope.authority.profile }), network: Object.freeze({ ...scope.authority.network }) }),
    grants: Object.freeze({ ...scope.app.grants }), configurationIdentity: scope.configuration.identity,
    rollout, policy: Object.freeze({ version: 1, failureMonitorSeconds: 30, updateTimeoutSeconds: 90, rollbackTimeoutSeconds: 90 }),
    services: Object.freeze({ [name]: Object.freeze({ image, resources: Object.freeze({ ...resources }),
      environment: Object.freeze(Object.fromEntries(environment.value)), command: service.command === null ? null : Object.freeze([...service.command]),
      entrypoint: service.entrypoint === null ? null : Object.freeze([...service.entrypoint]),
      health: Object.freeze({ ...service.health, command: Object.freeze([...service.health.command]) }), stopGraceSeconds: service.stopGraceSeconds }) }),
    routes: Object.freeze([Object.freeze({ host, path: route.path ?? null, service: name, port: route.port, check: route.check ?? route.path ?? "/",
      rateLimit: route.rateLimit === undefined ? null : Object.freeze({ ...route.rateLimit }) })]),
  }));
};
