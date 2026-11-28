import { managedServiceDigest } from "../../contracts/managed-service-plan.ts";
import { parseManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import { parseManagedServiceAction } from "../../contracts/managed-swarm-service.ts";
import type { ManagedRoutedReadinessPort, RoutedReadiness } from "../../contracts/routed-readiness.ts";
import { typed } from "../../lib/typed.ts";
import { httpReadinessProbe } from "./http-readiness-probe.ts";
import type { ReadinessOptions } from "./http-readiness-probe.ts";

/** Every route of this HTTP service must pass; other services' routes never substitute for it. */
export const managedRoutedReadiness = (options: ReadinessOptions = {}) => {
  const { now = Date.now } = options; const probe = httpReadinessProbe(options);
  return typed<ManagedRoutedReadinessPort>(Object.freeze({ check: async (action, input) => {
    const result = (status: RoutedReadiness["status"], checkedAt = now()) => Object.freeze({ app: action.app, service: action.service, incarnation: action.incarnation, action: action.action, plan: action.plan, checkedAt, status });
    const parsed = parseManagedApplicationPlan(input); const identity = parseManagedServiceAction(action);
    if (!parsed.ok || !identity.ok) return result("unavailable");
    const plan = parsed.value; const service = plan.services[action.service];
    if (service?.role !== "http" || service.owner.app !== action.app || service.owner.incarnation !== action.incarnation || service.owner.dataOwner !== action.dataOwner || managedServiceDigest(service) !== action.plan || action.effect !== "apply" && action.effect !== "restore") return result("unavailable");
    const routes = plan.routes.filter((route) => route.service === action.service); if (routes.length === 0) return result("unavailable");
    const observations = await Promise.all(routes.map(probe));
    const status = observations.every((value) => value.status === "ready") ? "ready" : observations.some((value) => value.status === "unavailable") ? "unavailable" : "unready";
    return result(status, Math.min(...observations.map((value) => value.checkedAt)));
  } }));
};
