import type { BuildPorts } from "../../contracts/build-artifact.ts";
import type { ManagedExecutionContext } from "../../contracts/managed-execution-context.ts";
import type { ManagedHealthReadPort } from "../../contracts/managed-deployment-read.ts";
import type { ImageResolutionPort } from "../../contracts/image-admission.ts";
import type { MigrationResolutionActor } from "../../contracts/migration-resolution.ts";
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
import { platformManagedPlans } from "./managed-plans.ts";
import { registrationWithdrawalObservation } from "../platform/registration-withdrawal.ts";
import { readRegistrationOwnership } from "../platform/registration-ownership.ts";
import { readPublicRegistration, readPublicRegistrationGeneration } from "../platform/public-registration.ts";
import { managedRemovalRuntime } from "./managed-removal-runtime.ts";
import type { ManagedRemovalIntent } from "../deployment/managed-removal-intent.ts";
import { managedRuntime } from "./managed-runtime.ts";
import { typed } from "../../lib/typed.ts";

type Index = Parameters<typeof managedPreparation>[0] & Parameters<typeof managedOperationControl>[0] & Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "recordedManagedVolumes" | "managedHealthContexts" |
  "requestManagedRemoval" | "inspectManagedRemoval" | "prepareManagedRemovalEffects" | "tickManagedRemovalEffects" | "retireManagedRemovalAccounting" | "completeManagedRemoval">>;
type Paths = Parameters<typeof platformManagedPlans>[0];
type Ports = { readonly builds: BuildPorts; readonly api: Pick<ReturnType<typeof dockerApi>, "request">; readonly canAccess: (app: string) => Promise<boolean>; readonly images?: ImageResolutionPort | undefined; readonly actor?: MigrationResolutionActor | undefined };

/** One composition in the existing privileged process. Constructing it creates no files, workloads, timers or additional Docker transport. */
export const managedPlatform = (index: Index, paths: Paths, ports: Ports) => {
  const { read, retain, now } = ports.builds; const environment = platformServiceInputs(paths.publicRegistrations, paths.privateRegistrations, 1000);
  const authority = platformManagedRuntimeAuthority({ ...paths, canAccess: ports.canAccess }); const volumes = ownedVolumes(ports.api, now);
  const native = { services: managedSwarmService(ports.api, volumes), volumes, jobs: oneShotJob(ports.api, now), checks: containerChecks(ports.api, now), checkFences: checkContainerFences(ports.api, now), readiness: managedRoutedReadiness({ now }) };
  const forRun = (context: ManagedExecutionContext) => Promise.resolve(managedRuntime(context, { read, retain, now, environment, authority,
    receipts: { read: (references) => index.recordedManagedVolumes(context.owner.app, references) }, native, observeHost: (host) => observeSwarmHost(host, ports.api) }));
  const plans = platformManagedPlans(paths, { read, images: ports.images ?? registryImages() });
  const preparation = managedPreparation(index, { builds: ports.builds, plans, inputs: environment, runtime: forRun });
  const prepare = async (app: string, run: string, commit: string) => { if (!await ports.canAccess(app)) throw new Error("app is outside managed deployment scope"); return preparation.prepare(app, run, commit); };
  const health = async (context: ManagedExecutionContext) => { const runtime = await forRun(context); return typed<ManagedHealthReadPort>({ read, now, services: { observe: runtime.services.observe, observeDesired: runtime.services.observeDesired } }); };
  const authorizeRemoval = async (intent: ManagedRemovalIntent) => {
    if (!await ports.canAccess(intent.owner.app)) return false;
    const published = await readPublicRegistrationGeneration(paths.publicRegistrations, intent.registration);
    if (!published.ok || published.value.app.runtime !== "swarm") return false;
    const [ownership, current] = await Promise.all([
      readRegistrationOwnership(paths.publicRegistrations, intent.registration),
      readPublicRegistration(paths.publicRegistrations, published.value.app.name),
    ]);
    return ownership.ok && current.ok && JSON.stringify(ownership.value.ownership) === JSON.stringify(intent.owner) &&
      JSON.stringify(current.value.metadata) === JSON.stringify(intent.registration);
  };
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
    request: (app: string, request: string, reason: string) => {
      const actor = ports.actor;
      if (actor === undefined) throw new Error("managed removal operator is unavailable");
      return index.requestManagedRemoval(app, request, { actor, reason }, { now, authorize: authorizeRemoval });
    },
    prepare: async (app: string, request: string) => index.prepareManagedRemovalEffects(app, request, await forRemoval(app, request)),
    tick: async (app: string, request: string) => index.tickManagedRemovalEffects(app, request, await forRemoval(app, request)),
    retireAccounting: async (app: string, request: string) => index.retireManagedRemovalAccounting(app, request, await forRemoval(app, request)),
    finalize: async (app: string, request: string) => index.completeManagedRemoval(app, request, {
      ...await forRemoval(app, request), observeWithdrawal,
    }),
  });
  return Object.freeze({
    prepare, removal,
    commands: managedOperationControl(index, { read, now, canAccess: ports.canAccess, prepare, forRun, actor: ports.actor }),
    work: Object.freeze({ read, now, forRun }),
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
