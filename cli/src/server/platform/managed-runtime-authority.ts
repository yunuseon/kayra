import type { App } from "../../contracts/app-registration.ts";
import type { RegistrationGeneration } from "../../contracts/registration-generation.ts";
import type { RegistrationInfrastructure } from "../../contracts/registration-infrastructure.ts";
import type { SwarmAuthority } from "../../contracts/swarm-authority.ts";
import type { ManagedExecutionContext } from "../../contracts/managed-execution-context.ts";
import { parseManagedExecutionContext } from "../../contracts/managed-execution-context.ts";
import type { ManagedRuntimeAuthorityPort, ManagedRuntimePermission } from "../../contracts/managed-runtime-authority.ts";
import { managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import { parseManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import type { MigrationPolicy } from "../../contracts/migration-policy.ts";
import { readRegistrationOwnership } from "./registration-ownership.ts";
import { readRegistrationInfrastructure } from "./registration-infrastructure.ts";
import { readPublicRegistration, readPublicRegistrationGeneration } from "./public-registration.ts";
import { readPrivateConfiguration } from "./private-registration.ts";
import { readSwarmAuthority } from "./swarm-authority.ts";
import { readMigrationPolicy } from "./migration-policy.ts";
import { typed } from "../../lib/typed.ts";

type Current = { readonly registration: RegistrationGeneration; readonly app: App; readonly host: SwarmAuthority;
  readonly infrastructure: RegistrationInfrastructure; readonly configurationIdentity: string; readonly migrationPolicy: MigrationPolicy };
type Ports = { readonly owned: (context: ManagedExecutionContext) => Promise<boolean>; readonly current: (context: ManagedExecutionContext) => Promise<Current | undefined> };
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const cleanup = (context: ManagedExecutionContext, permission: ManagedRuntimePermission) => {
  if (permission.kind === "accepted-recovery" || permission.kind === "recovery") return true;
  if (permission.kind === "migration-resolution") return permission.request.app === context.owner.app && permission.request.run === context.run;
  if (permission.kind === "migration") return permission.effect === "fence";
  if (permission.kind === "job") return (permission.effect === "observe" || permission.effect === "fence") && permission.job.scope.app === context.owner.app && permission.job.scope.incarnation === context.owner.incarnation && permission.job.scope.run === context.run;
  if (permission.kind !== "service" || permission.purpose !== "cleanup") return false;
  const action = parseManagedServiceAction(permission.action);
  return action.ok && ["fence", "remove", "scrub"].includes(action.value.effect) && action.value.app === context.owner.app && action.value.incarnation === context.owner.incarnation && action.value.dataOwner === context.owner.dataOwner && action.value.action.split(":").slice(0, 2).join(":") === context.action;
};

/** Current platform policy only. The coordinator independently validates its request, admission lease, effect intent and runtime ownership. */
export const managedRuntimeAuthority = (ports: Ports) => typed<ManagedRuntimeAuthorityPort>(Object.freeze({
  allowed: async (input, permission) => {
    try {
      const checked = parseManagedExecutionContext(input); if (!checked.ok) return false; const context = checked.value;
      if (!await ports.owned(context)) return false;
      if (cleanup(context, permission)) return true;
      const current = await ports.current(context); const plan = context.application;
      if (current?.app.runtime !== "swarm" || current.app.name !== context.owner.app || !same(current.registration, plan.infrastructure.registration) || !same(current.infrastructure, plan.infrastructure) || !same(current.host, plan.host) || current.configurationIdentity !== plan.configurationIdentity ||
        plan.grants.memory_bytes > current.app.grants.memory_bytes || plan.grants.cpu_millicores > current.app.grants.cpu_millicores || plan.rollout.strategy === "maintenance" && !current.app.grants.maintenance || plan.policy.migrationTimeoutCeilingSeconds > current.migrationPolicy.migrationTimeoutCeilingSeconds ||
        plan.hosts.some((host) => !current.app.hosts.includes(host)) || plan.secrets.some((secret) => !current.app.secrets.includes(secret))) return false;
      if (permission.kind === "service-inputs") {
        if (![context.application, ...(context.previous === null ? [] : [context.previous])].some((known) => managedApplicationDigest(known) === managedApplicationDigest(permission.application)) || !same(permission.service, permission.application.services[permission.service.service])) return false;
        return permission.application.hosts.every((host) => current.app.hosts.includes(host)) && Object.values(permission.service.inputs.environment).every((binding) => binding.kind !== "secret" || current.app.secrets.includes(binding.key));
      }
      if (permission.kind === "job") return permission.job.scope.app === context.owner.app && permission.job.scope.incarnation === context.owner.incarnation && permission.job.scope.run === context.run && (permission.effect === "create" || permission.effect === "start");
      if (permission.kind === "service") return permission.action.app === context.owner.app && permission.action.incarnation === context.owner.incarnation && permission.action.dataOwner === context.owner.dataOwner && permission.action.action.split(":").slice(0, 2).join(":") === context.action && (permission.purpose === "deployment" || permission.action.effect === "apply" || permission.action.effect === "restore");
      return permission.kind === "admission" || permission.kind === "allocation" || permission.kind === "verify" || permission.kind === "check" || permission.kind === "migration" && (permission.effect === "create" || permission.effect === "start");
    } catch { return false; }
  },
}));

/** Platform-owned publication readers. They never open deployment journals, inspect a branch or resolve secret values for policy. */
export const platformManagedRuntimeAuthority = (paths: { readonly publicRegistrations: string; readonly privateRegistrations: string; readonly swarmAuthority: string; readonly migrationPolicy: string; readonly canAccess: (app: string) => Promise<boolean> }) => managedRuntimeAuthority({
  owned: async (context) => {
    if (!await paths.canAccess(context.owner.app)) return false;
    const reference = await readRegistrationOwnership(paths.publicRegistrations, context.application.infrastructure.registration);
    return reference.ok && same(reference.value.ownership, context.owner);
  },
  current: async (context) => {
    const reference = context.application.infrastructure.registration; const immutable = await readPublicRegistrationGeneration(paths.publicRegistrations, reference); if (!immutable.ok) return undefined;
    const [registration, host, configuration, policy] = await Promise.all([readPublicRegistration(paths.publicRegistrations, immutable.value.app.name), readSwarmAuthority(paths.swarmAuthority), readPrivateConfiguration(paths.privateRegistrations, reference, 1000), readMigrationPolicy(paths.migrationPolicy)]);
    if (!registration.ok || !host.ok || !configuration.ok || !policy.ok) return undefined;
    const infrastructure = await readRegistrationInfrastructure(paths.publicRegistrations, reference, host.value); if (!infrastructure.ok) return undefined;
    return Object.freeze({ registration: registration.value.metadata, app: registration.value.app, host: host.value, infrastructure: infrastructure.value, configurationIdentity: configuration.value.identity, migrationPolicy: policy.value });
  },
});
