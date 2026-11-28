import { z } from "zod";
import type { BuildPorts } from "../../contracts/build-artifact.ts";
import type { ManagedPlanPort } from "../../contracts/managed-plan.ts";
import type { RetainedInputsPort } from "../../contracts/service-inputs.ts";
import type { ManagedExecutionContext } from "../../contracts/managed-execution-context.ts";
import type { IndexedManagedRuntime } from "./indexed-managed-lifecycle.ts";
import type { openLifecycleAppIndex } from "./lifecycle-app-index.ts";
import { managedSourceContext } from "./managed-source-context.ts";
import type { ManagedLifecycleSource } from "./managed-lifecycle-source.ts";

type Index = Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "acceptedManagedRequest" | "retainedManagedBuild" | "managedRequestSource" | "managedRestoreCandidate" | "managedPreviewVolumes" | "prepareBuild" | "registrationPolicy" | "reserveDataVolumeIdentities" | "proposeManagedDeployment" | "requestManagedDeployment">>;
type Ports = { readonly builds: BuildPorts; readonly plans: ManagedPlanPort; readonly inputs: RetainedInputsPort;
  readonly runtime: (context: ManagedExecutionContext) => Promise<IndexedManagedRuntime | undefined> };

/** Sequential owner calls avoid re-entering an app writer from a compiler or runtime callback. Acceptance independently revalidates scope and admission. */
export const managedPreparation = (index: Index, ports: Ports) => {
  const bounded = async <T>(call: () => Promise<T>) => {
    const expired = Promise.withResolvers<never>(); const timer = setTimeout(() => { expired.reject(new Error("managed preparation input deadline expired")); }, 10_000);
    try { return await Promise.race([Promise.resolve().then(call), expired.promise]); } finally { clearTimeout(timer); }
  };
  const accept = async (app: string, source: ManagedLifecycleSource, lookup: () => ReturnType<Index["acceptedManagedRequest"]>) => {
    const runtime = await bounded(() => ports.runtime(managedSourceContext(source)));
    if (runtime === undefined) throw new Error("managed runtime unavailable");
    try { return await index.requestManagedDeployment(app, source, runtime); }
    catch (error) {
      const accepted = await lookup();
      if (accepted !== undefined) return accepted.request;
      throw error;
    }
  };
  const prepare = async (app: string, run: string, commit: string) => {
    if (!z.uuid().safeParse(run).success || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("managed preparation requires a run identity and exact commit");
    const existing = await index.managedRequestSource(app, run, commit, ports.builds);
    if (existing !== undefined && existing.request.completion !== null) return existing.request;
    const source = existing?.source ?? await (async () => {
      const build = await index.prepareBuild(app, commit, ports.builds); const registration = await index.registrationPolicy(app);
      if (registration.runtime !== "swarm" || JSON.stringify(build.registration) !== JSON.stringify(registration.metadata)) throw new Error("managed preparation registration changed during build");
      const keys = await bounded(() => ports.plans.volumeKeys(registration.metadata, commit, build.artifact));
      const volumes = await index.reserveDataVolumeIdentities(app, keys);
      const candidate = await bounded(() => ports.plans.preview(registration.metadata, commit, build.artifact, volumes));
      if (candidate.commit !== commit || candidate.artifact !== build.artifact) throw new Error("managed compiler changed the requested build identity");
      return index.proposeManagedDeployment(app, candidate, run, { ...ports.builds, ...ports.inputs });
    })();
    return accept(app, source, () => index.managedRequestSource(app, run, commit, ports.builds));
  };
  const restore = async (app: string, run: string, record: string) => {
    if (!z.uuid().safeParse(run).success || !/^[a-f0-9]{64}$/.test(record)) throw new Error("managed restore requires a run identity and verified release record");
    const lookup = async () => {
      const accepted = await index.acceptedManagedRequest(app, run, ports.builds);
      if (accepted !== undefined && accepted.source.restore !== record) throw new Error("managed restore request identity conflicts");
      return accepted;
    };
    const existing = await lookup();
    if (existing !== undefined && existing.request.completion !== null) return existing.request;
    const source = existing?.source ?? await (async () => {
      const target = await index.managedRestoreCandidate(app, record, ports.builds);
      if (target === null) throw new Error("managed restore lacks verified release history");
      return index.proposeManagedDeployment(app, target, run, { ...ports.builds, ...ports.inputs }, record);
    })();
    return accept(app, source, lookup);
  };
  const preview = async (app: string, commit: string) => {
    const build = await index.retainedManagedBuild(app, commit, ports.builds);
    const keys = await bounded(() => ports.plans.volumeKeys(build.registration, commit, build.artifact));
    const volumes = await index.managedPreviewVolumes(app, keys);
    const candidate = await bounded(() => ports.plans.preview(build.registration, commit, build.artifact, volumes));
    if (candidate.commit !== commit || candidate.artifact !== build.artifact || JSON.stringify(candidate.infrastructure.registration) !== JSON.stringify(build.registration)) {
      throw new Error("managed compiler changed the requested build identity");
    }
    return candidate;
  };
  return Object.freeze({ prepare, restore, preview });
};
