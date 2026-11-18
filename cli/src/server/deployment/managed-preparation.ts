import { z } from "zod";
import type { BuildPorts } from "../../contracts/build-artifact.ts";
import type { ManagedPlanPort } from "../../contracts/managed-plan.ts";
import type { RetainedInputsPort } from "../../contracts/service-inputs.ts";
import type { ManagedExecutionContext } from "../../contracts/managed-execution-context.ts";
import type { IndexedManagedRuntime } from "./indexed-managed-lifecycle.ts";
import type { openLifecycleAppIndex } from "./lifecycle-app-index.ts";
import { managedSourceContext } from "./managed-source-context.ts";

type Index = Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "managedRequestSource" | "prepareBuild" | "registrationPolicy" | "reserveDataVolumeIdentities" | "proposeManagedDeployment" | "requestManagedDeployment">>;
type Ports = { readonly builds: BuildPorts; readonly plans: ManagedPlanPort; readonly inputs: RetainedInputsPort;
  readonly runtime: (context: ManagedExecutionContext) => Promise<IndexedManagedRuntime | undefined> };

/** Sequential owner calls avoid re-entering an app writer from a compiler or runtime callback. Acceptance independently revalidates scope and admission. */
export const managedPreparation = (index: Index, ports: Ports) => {
  const bounded = async <T>(call: () => Promise<T>) => {
    const expired = Promise.withResolvers<never>(); const timer = setTimeout(() => { expired.reject(new Error("managed preparation input deadline expired")); }, 10_000);
    try { return await Promise.race([Promise.resolve().then(call), expired.promise]); } finally { clearTimeout(timer); }
  };
  return Object.freeze({ prepare: async (app: string, run: string, commit: string) => {
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
    const runtime = await bounded(() => ports.runtime(managedSourceContext(source)));
    if (runtime === undefined) throw new Error("managed runtime unavailable");
    try { return await index.requestManagedDeployment(app, source, runtime); }
    catch (error) {
      const accepted = await index.managedRequestSource(app, run, commit, ports.builds);
      if (accepted !== undefined) return accepted.request;
      throw error;
    }
  } });
};
