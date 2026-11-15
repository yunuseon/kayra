import { createHash } from "node:crypto";
import { parseApplicationPlan } from "../../contracts/application-plan.ts";
import type { RoutedReadiness, RoutedReadinessPort } from "../../contracts/routed-readiness.ts";
import { typed } from "../../lib/typed.ts";
import { httpReadinessProbe } from "./http-readiness-probe.ts";
import type { ReadinessOptions } from "./http-readiness-probe.ts";

/** Fixed platform address, app SNI/Host, trusted TLS, fresh connections and no redirects or retries. */
export const routedReadiness = (options: ReadinessOptions = {}) => {
  const { now = Date.now } = options; const probe = httpReadinessProbe(options);
  return typed<RoutedReadinessPort>(Object.freeze({
    check: async (action, input) => {
      const result = (status: RoutedReadiness["status"]) => Object.freeze({ app: action.app, service: action.service, incarnation: action.incarnation, action: action.action, plan: action.plan, checkedAt: now(), status });
      const checked = parseApplicationPlan(input);
      const route = checked.ok ? checked.value.routes.find((route) => route.service === action.service) : undefined;
      if (!checked.ok || checked.value.app !== action.app || checked.value.registration.incarnation !== action.incarnation || createHash("sha256").update(JSON.stringify(checked.value)).digest("hex") !== action.plan || route === undefined) return result("unavailable");
      return result((await probe(route)).status);
    },
  }));
};
