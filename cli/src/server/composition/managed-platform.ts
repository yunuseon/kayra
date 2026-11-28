import { randomUUID } from "node:crypto";
import type { BuildPorts } from "../../contracts/build-artifact.ts";
import type { ManagedExecutionContext } from "../../contracts/managed-execution-context.ts";
import type { ManagedHealthReadPort } from "../../contracts/managed-deployment-read.ts";
import type { ImageResolutionPort } from "../../contracts/image-admission.ts";
import type { MigrationResolutionActor } from "../../contracts/migration-resolution.ts";
import { managedRecreationRegistrationRequest, managedRecreationReleaseRequest } from "../../contracts/managed-recreation.ts";
import type { openLifecycleAppIndex } from "../deployment/lifecycle-app-index.ts";
import type { dockerApi } from "../runtime/docker-api.ts";
import { managedPreparation } from "../deployment/managed-preparation.ts";
import { managedOperationControl } from "../deployment/managed-operation-control.ts";
import { platformManagedRuntimeAuthority } from "../platform/managed-runtime-authority.ts";
import { platformServiceInputs } from "../platform/service-inputs.ts";
import { managedRoutedReadiness } from "../platform/managed-routed-readiness.ts";
import { ownedVolumes } from "../runtime/owned-volume.ts";
import { managedSwarmService } from "../runtime/managed-swarm-service.ts";
import { containerChecks } from "../runtime/container-check.ts";
import { checkContainerFences } from "../runtime/check-container-fence.ts";
import { oneShotCleanup, oneShotJob } from "../runtime/one-shot-job.ts";
import { observeSwarmHost } from "../runtime/swarm-host.ts";
import { registryImages } from "../runtime/registry-images.ts";
import { platformManagedPlans, platformManagedRecreationPlan } from "./managed-plans.ts";
import { registrationWithdrawalObservation } from "../platform/registration-withdrawal.ts";
import { readRegistrationOwnership } from "../platform/registration-ownership.ts";
import { readPublicRegistration, readPublicRegistrationGeneration } from "../platform/public-registration.ts";
import { managedRemovalRuntime } from "./managed-removal-runtime.ts";
import type { ManagedRemovalIntent } from "../deployment/managed-removal-intent.ts";
import { managedRuntime } from "./managed-runtime.ts";
import { managedForwardCleanupRuntime } from "./managed-forward-cleanup-runtime.ts";
import { managedForwardOperation } from "../deployment/managed-forward-operation.ts";
import { reconcileManagedForwardWork } from "../deployment/managed-forward-work.ts";
import { managedSourceContext } from "../deployment/managed-source-context.ts";
import type { ManagedForwardCleanupContext } from "../../contracts/managed-forward-cleanup-context.ts";
import type { RegistrationGeneration } from "../../contracts/registration-generation.ts";
import type { DataOwnership } from "../../contracts/owned-volume.ts";
import { typed } from "../../lib/typed.ts";

type Index = Parameters<typeof managedPreparation>[0] & Parameters<typeof managedOperationControl>[0] & Parameters<typeof managedForwardOperation>[0] & Parameters<typeof reconcileManagedForwardWork>[0] & Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "recordedManagedVolumes" | "managedHealthContexts" |
  "requestManagedRemoval" | "inspectManagedRemoval" | "prepareManagedRemovalEffects" | "tickManagedRemovalEffects" | "retireManagedRemovalAccounting" | "completeManagedRemoval" |
  "managedRemovalIntent" | "managedRemovalTombstone" | "managedPurgeIntent" | "requestManagedPurge" | "tickManagedPurge" |
  "reserveManagedRecreation" | "prepareManagedRecreationWorkspace" | "switchManagedRecreationOwnership" | "reserveRecreatedRegistration" |
  "reserveManagedRebind" | "requestManagedDeployment">>;
type Paths = Parameters<typeof platformManagedPlans>[0];
type Ports = { readonly builds: BuildPorts; readonly api: Pick<ReturnType<typeof dockerApi>, "request">; readonly canAccess: (app: string) => Promise<boolean>; readonly images?: ImageResolutionPort | undefined; readonly actor?: MigrationResolutionActor | undefined };

/** One composition in the existing privileged process. Constructing it creates no files, workloads, timers or additional Docker transport. */
export const managedPlatform = (index: Index, paths: Paths, ports: Ports) => {
  const { read, retain, now } = ports.builds; const environment = platformServiceInputs(paths.publicRegistrations, paths.privateRegistrations, 1000);
  const authority = platformManagedRuntimeAuthority({ ...paths, canAccess: ports.canAccess }); const volumes = ownedVolumes(ports.api, now);
  const native = { services: managedSwarmService(ports.api, volumes), volumes, jobs: oneShotJob(ports.api, now), checks: containerChecks(ports.api, now), checkFences: checkContainerFences(ports.api, now), readiness: managedRoutedReadiness({ now }) };
  const makeRuntime = (context: ManagedExecutionContext) => managedRuntime(context, { read, retain, now, environment, authority,
    receipts: { read: (references) => index.recordedManagedVolumes(context.owner.app, references) }, native, observeHost: (host) => observeSwarmHost(host, ports.api) });
  const forRun = (context: ManagedExecutionContext) => Promise.resolve(makeRuntime(context));
  const plans = platformManagedPlans(paths, { read, images: ports.images ?? registryImages() });
  const recreated = platformManagedRecreationPlan(paths, { read, images: ports.images ?? registryImages() });
  const preparation = managedPreparation(index, { builds: ports.builds, plans, inputs: environment, runtime: forRun });
  const prepare = async (app: string, run: string, commit: string) => { if (!await ports.canAccess(app)) throw new Error("app is outside managed deployment scope"); return preparation.prepare(app, run, commit); };
  const health = async (context: ManagedExecutionContext) => { const runtime = await forRun(context); return typed<ManagedHealthReadPort>({ read, now, services: { observe: runtime.services.observe, observeDesired: runtime.services.observeDesired } }); };
  const currentRegistration = async (registration: RegistrationGeneration, scoped: DataOwnership) => {
    if (!await ports.canAccess(scoped.app)) return undefined;
    const published = await readPublicRegistrationGeneration(paths.publicRegistrations, registration);
    if (!published.ok || published.value.app.runtime !== "swarm") return undefined;
    const [ownership, current] = await Promise.all([
      readRegistrationOwnership(paths.publicRegistrations, registration),
      readPublicRegistration(paths.publicRegistrations, published.value.app.name),
    ]);
    return ownership.ok && current.ok && JSON.stringify(ownership.value.ownership) === JSON.stringify(scoped) &&
      JSON.stringify(current.value.metadata) === JSON.stringify(registration) ? published.value.app : undefined;
  };
  const authorizeRemoval = async (intent: ManagedRemovalIntent) => await currentRegistration(intent.registration, intent.owner) !== undefined;
  const forwardPorts = typed<Parameters<typeof managedForwardOperation>[1]>({
    read, retain, now, images: ports.builds.images, compare: environment.compare, plans, builds: ports.builds, canAccess: ports.canAccess, actor: ports.actor,
    authorize: async (audit) => (await currentRegistration(audit.registration, audit.owner))?.grants.maintenance === true,
    authorizeReservation: async (decision, _candidate, operator) =>
      JSON.stringify(operator.actor) === JSON.stringify(ports.actor) &&
      (await currentRegistration(decision.audit.registration, decision.audit.owner))?.grants.maintenance === true,
  });
  const forward = managedForwardOperation(index, forwardPorts);
  const forwardRuntime = (context: ManagedForwardCleanupContext) => managedForwardCleanupRuntime(context, { now, authority,
    native: { services: native.services, jobs: native.jobs, containers: native.checkFences },
  });
  const reconcileForward = () => reconcileManagedForwardWork(index, { ...forwardPorts, runtime: forwardRuntime,
    retained: (context) => makeRuntime(context.blocked).services.observeDesired,
    authorizeTransfer: (source) => authority.allowed(managedSourceContext(source), { kind: "admission" }),
    observeHost: (host) => observeSwarmHost(host, ports.api),
  });
  const removalJobs = oneShotCleanup(ports.api, now);
  const forRemoval = async (app: string, request: string) => {
    if (!await ports.canAccess(app)) throw new Error("app is outside managed removal scope");
    const inventory = await index.inspectManagedRemoval(app, request, { read, now });
    return managedRemovalRuntime(inventory, {
      read, retain, now, authorize: authorizeRemoval,
      native: { services: native.services, jobs: removalJobs, containers: native.checkFences },
    });
  };
  const observeWithdrawal = registrationWithdrawalObservation(paths.publicRegistrations, now);
  const removal = Object.freeze({
    step: async (app: string) => {
      if (!await ports.canAccess(app) || ports.actor === undefined) throw new Error("app is outside managed removal scope");
      const removed = await index.managedRemovalTombstone(app);
      if (removed !== undefined) return Object.freeze({ status: "removed" as const, request: removed.request });
      const intent = await index.managedRemovalIntent(app) ?? await index.requestManagedRemoval(app, randomUUID(), {
        actor: ports.actor, reason: "Remove the managed application and retain its owned data",
      }, { now, authorize: authorizeRemoval });
      const runtime = await forRemoval(app, intent.request);
      const prepared = await index.prepareManagedRemovalEffects(app, intent.request, runtime);
      const state = prepared.phase === "complete" || prepared.phase === "held" ? prepared :
        await index.tickManagedRemovalEffects(app, intent.request, runtime);
      if (state.phase === "held") return Object.freeze({ status: "held" as const, request: intent.request, reason: state.reason });
      if (state.phase !== "complete") return Object.freeze({ status: "removing" as const, request: intent.request, deadline: state.deadline });
      await index.retireManagedRemovalAccounting(app, intent.request, runtime);
      return Object.freeze({ status: "withdraw-registration" as const, withdrawal: Object.freeze({
        version: 1 as const, request: intent.request, action: intent.action, registration: intent.registration,
      }) });
    },
    finalize: async (app: string, request: string) => {
      const receipt = await index.completeManagedRemoval(app, request, { ...await forRemoval(app, request), observeWithdrawal });
      return Object.freeze({ status: "removed" as const, request: receipt.request });
    },
  });
  const purge = async (app: string) => {
    const actor = ports.actor;
    if (actor === undefined || !await ports.canAccess(app)) throw new Error("app is outside managed purge scope");
    const tombstone = await index.managedRemovalTombstone(app);
    if (tombstone === undefined) throw new Error("managed purge requires completed application removal");
    const runtime = Object.freeze({
      now, observeWithdrawal, authorize: (intent: ManagedRemovalIntent) => ports.canAccess(intent.owner.app),
      native: { observe: volumes.observe, attachments: volumes.attachments, remove: volumes.remove },
    });
    const accepted = await index.managedPurgeIntent(app, tombstone.request, runtime) ??
      await index.requestManagedPurge(app, tombstone.request, randomUUID(), {
        actor, reason: "Purge the retained data of this explicitly removed managed application",
      }, runtime);
    const state = await index.tickManagedPurge(app, tombstone.request, accepted.request, runtime);
    if (state.phase === "complete") return Object.freeze({ status: "purged" as const, request: state.request });
    if (state.phase === "held") return Object.freeze({ status: "held" as const, request: state.request, reason: state.reason });
    return Object.freeze({ status: "purging" as const, request: state.request, deadline: state.deadline });
  };
  const recreateRegistration = async (input: unknown) => {
    const parsed = managedRecreationRegistrationRequest.safeParse(input);
    const actor = ports.actor;
    if (!parsed.success || actor === undefined || !await ports.canAccess(parsed.data.app)) throw new Error("app is outside managed recreation scope");
    const { app, ...request } = parsed.data;
    const scoped = Object.freeze({
      read, retain, now, observeWithdrawal,
      authorize: (intent: ManagedRemovalIntent) => ports.canAccess(intent.owner.app),
      native: { observe: volumes.observe, attachments: volumes.attachments },
    });
    await index.reserveManagedRecreation(app, request, actor, scoped);
    await index.prepareManagedRecreationWorkspace(app, request.request, scoped);
    await index.switchManagedRecreationOwnership(app, request.request, scoped);
    return index.reserveRecreatedRegistration(app, request.request, request.generation, {
      read, now, authorize: (intent) => ports.canAccess(intent.predecessor.app),
    });
  };
  const recreateRelease = async (input: unknown) => {
    const parsed = managedRecreationReleaseRequest.safeParse(input);
    if (!parsed.success || ports.actor === undefined || !await ports.canAccess(parsed.data.app)) throw new Error("app is outside managed recreation scope");
    const { app, request } = parsed.data;
    const source = await index.reserveManagedRebind(app, request, { read, retain, now, ...recreated });
    return index.requestManagedDeployment(app, source, await forRun(managedSourceContext(source)));
  };
  return Object.freeze({
    prepare, preview: preparation.preview, forward, removal, purge, recreateRegistration, recreateRelease,
    commands: managedOperationControl(index, { read, now, canAccess: ports.canAccess, prepare, restore: preparation.restore, forRun, actor: ports.actor }),
    work: Object.freeze({ read, now, forRun, reconcileForward }),
    health,
    healthSnapshot: async () => {
      const contexts = await index.managedHealthContexts({ read, now }); const readers = new Map(await Promise.all(contexts.map(async (context) => [context.owner.app, await health(context)] as const)));
      return typed<ManagedHealthReadPort>({ read, now, services: {
        observe: (scope) => readers.get(scope.app)?.services.observe(scope) ?? Promise.resolve({ status: "unavailable" }),
        observeDesired: (action, spec, application) => readers.get(action.app)?.services.observeDesired(action, spec, application) ?? Promise.resolve({ status: "unavailable" }),
      } });
    },
  });
};
