import { parseManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import { managedServiceName } from "../../contracts/managed-service-plan.ts";
import { err } from "../../lib/result.ts";

type Scope = Pick<ManagedApplicationPlan, "infrastructure" | "host" | "grants" | "hosts" | "secrets" | "configurationIdentity" | "policy">;

/** The prior verified plan fixes workload behavior. The platform supplies the successor's current authority and separately compares materialized inputs. */
export const recreatedManagedPlan = (input: ManagedApplicationPlan, scope: Scope) => {
  const checked = parseManagedApplicationPlan(input);
  if (!checked.ok) return checked;
  const previous = checked.value;
  const before = previous.infrastructure.ownership;
  const owner = scope.infrastructure.ownership;
  const network = scope.infrastructure.overlay;
  if (owner.app !== before.app || owner.dataOwner !== before.dataOwner || owner.incarnation === before.incarnation ||
    scope.host.node !== previous.host.node || scope.host.cluster !== previous.host.cluster ||
    network.id === previous.infrastructure.overlay.id) return err("recreated workload authority disagrees with the retired data owner");
  const services = Object.freeze(Object.fromEntries(Object.entries(previous.services).map(([name, spec]) => [name, Object.freeze({
    ...spec, owner, nativeName: managedServiceName(owner, name),
    inputs: Object.freeze({ ...spec.inputs, registration: scope.infrastructure.registration, configurationIdentity: scope.configurationIdentity }),
    host: Object.freeze({ node: scope.host.node, cluster: scope.host.cluster, routingNetwork: spec.role === "http" ? scope.host.network.id : null }),
    privateNetwork: Object.freeze({ id: network.id, name: network.scope.name }),
  })] as const)));
  return parseManagedApplicationPlan({
    ...previous, ...scope, services, rollout: { ...previous.rollout, migrations: [] },
  });
};
