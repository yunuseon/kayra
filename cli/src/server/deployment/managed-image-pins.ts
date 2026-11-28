import type { BuildPorts } from "../../contracts/build-artifact.ts";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import { managedApplicationDigest } from "../../contracts/managed-application-plan.ts";
import { managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import { parseManagedImagePins } from "../../contracts/managed-image-pins.ts";
import type { ManagedImagePins } from "../../contracts/managed-image-pins.ts";
import { managedDeploymentEvidence } from "./managed-deployment-evidence.ts";

type Reference = { readonly application: ManagedApplicationPlan; readonly role: ManagedImagePins["plans"][number]["roles"][number] };
/** Conservative plan/bundle pins, including failed candidates and scrubbed retained specifications. Never a live attachment inventory or GC grant. */
export const managedImagePins = async (input: unknown, sourceInput: unknown, ports: Pick<BuildPorts, "read">) => {
  const { state, source, active, lastGood } = await managedDeploymentEvidence(input, sourceInput, ports);
  const reference = (application: ManagedApplicationPlan | undefined, role: Reference["role"]) => application === undefined ? Object.freeze([]) : Object.freeze([Object.freeze({ application, role })]);
  const references = Object.freeze([
    ...reference(active?.release.source.application, "active"), ...reference(lastGood?.release.source.application, "last-known-good"),
    ...reference(source.previous?.source.application, "rollback"), ...reference(source.candidate, "candidate"),
    ...(state.operation.phase === "held" || !state.operation.settled ? reference(source.candidate, "unresolved") : Object.freeze([])),
  ]);
  const plans = Object.freeze([...new Set(references.map((value) => managedApplicationDigest(value.application)))].toSorted().map((plan) => {
    const matching = references.filter((value) => managedApplicationDigest(value.application) === plan); const application = matching[0]?.application;
    if (application === undefined) throw new Error("managed pin plan is missing");
    return Object.freeze({ plan, bundle: application.artifact, commit: application.commit, roles: Object.freeze([...new Set(matching.map((value) => value.role))].toSorted()),
      images: Object.freeze([...new Set([...application.images.map((value) => value.pull), ...Object.values(application.services).map((value) => value.image)])].toSorted()) });
  }));
  const parsed = parseManagedImagePins({ version: 3, protocol: "managed-v3", runtime: "swarm", app: state.owner.app, incarnation: state.owner.incarnation,
    scope: "deployment-evidence", gcSafe: false, attachments: "not-observed", plans,
    retired: source.retired.map((value) => Object.freeze({ service: value.plan.service, specification: managedServiceDigest(value.plan), image: value.plan.image })),
  });
  if (!parsed.ok) throw new Error(parsed.error); return parsed.value;
};
