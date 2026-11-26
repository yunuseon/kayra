import { parseManagedForwardSelectionRequest } from "../../contracts/managed-forward-selection.ts";
import type { BuildPorts } from "../../contracts/build-artifact.ts";
import type { ManagedPlanPort } from "../../contracts/managed-plan.ts";
import type { MigrationResolutionActor } from "../../contracts/migration-resolution.ts";
import type { openLifecycleAppIndex } from "./lifecycle-app-index.ts";

type Index = Readonly<Pick<Awaited<ReturnType<typeof openLifecycleAppIndex>>, "selectManagedForward" | "prepareManagedForwardBuild" |
  "reserveDataVolumeIdentities" | "reserveManagedForward" | "acceptedManagedRequest">>;
type Ports = Parameters<Index["reserveManagedForward"]>[4] & {
  readonly builds: BuildPorts;
  readonly plans: ManagedPlanPort;
  readonly actor: MigrationResolutionActor | undefined;
  readonly canAccess: (app: string) => Promise<boolean>;
};

/** The explicit operator decision may prepare an immutable build. Workload effects start only after the indexed reservation is published. */
export const managedForwardOperation = (index: Index, ports: Ports) => async (input: unknown) => {
  const checked = parseManagedForwardSelectionRequest(input);
  const actor = ports.actor;
  if (!checked.ok || actor === undefined || !await ports.canAccess(checked.value.app)) throw new Error("managed forward command is unavailable or outside scope");
  const request = checked.value; const { app } = request;
  const selected = await index.selectManagedForward(app, request, actor, ports);
  const accepted = await index.acceptedManagedRequest(app, request.request, ports);
  if (accepted !== undefined) {
    if (accepted.source.candidate.commit !== request.commit || accepted.source.forward?.decision !== selected.id) throw new Error("managed forward request conflicts");
    return Object.freeze({ version: 1 as const, request: request.request, decision: selected.id, phase: "activated" as const, deploymentDeadline: accepted.request.deadline });
  }
  const { build } = await index.prepareManagedForwardBuild(app, request, { ...ports.builds, authorizeSelection: ports.authorize });
  const keys = await ports.plans.volumeKeys(build.registration, build.commit, build.artifact);
  const volumes = await index.reserveDataVolumeIdentities(app, keys);
  const candidate = await ports.plans.preview(build.registration, build.commit, build.artifact, volumes);
  const reserved = await index.reserveManagedForward(app, request, candidate, { actor, reason: request.reason }, ports);
  return Object.freeze({ version: 1 as const, request: reserved.run, decision: selected.id, phase: reserved.phase, cleanupDeadline: reserved.deadline,
    ...(reserved.phase === "transferring" ? { admissionDeadline: reserved.handoff.deadline } : {}),
  });
};
