import { createHash } from "node:crypto";
import { request } from "node:https";
import { parseApplicationPlan } from "../../contracts/application-plan.ts";
import type { RoutedReadiness, RoutedReadinessPort } from "../../contracts/routed-readiness.ts";
import { typed } from "../../lib/typed.ts";

type Options = {
  readonly address?: string; readonly port?: number; readonly ca?: string;
  readonly timeoutMs?: number; readonly now?: () => number;
};

/** Fixed platform address, app SNI/Host, trusted TLS, fresh connections and no redirects or retries. */
export const routedReadiness = ({ address = "traefik", port = 443, ca, timeoutMs = 2000, now = Date.now }: Options = {}) => {
  if (!/^[a-zA-Z0-9.-]+$/.test(address) || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000 ||
    (ca !== undefined && (ca.length > 256 * 1024 || !ca.includes("-----BEGIN CERTIFICATE-----") || ca.includes("PRIVATE KEY")))) throw new Error("invalid platform readiness policy");
  return typed<RoutedReadinessPort>(Object.freeze({
    check: async (action, input) => {
      const result = (status: RoutedReadiness["status"]) => Object.freeze({ app: action.app, service: action.service, incarnation: action.incarnation, action: action.action, plan: action.plan, checkedAt: now(), status });
      const checked = parseApplicationPlan(input);
      const route = checked.ok ? checked.value.routes.find((route) => route.service === action.service) : undefined;
      if (!checked.ok || checked.value.app !== action.app || checked.value.registration.incarnation !== action.incarnation || createHash("sha256").update(JSON.stringify(checked.value)).digest("hex") !== action.plan || route === undefined) return result("unavailable");
      return new Promise<RoutedReadiness>((resolve) => {
        const probe = request({ hostname: address, port, servername: route.host, path: route.check, method: "GET", headers: { Host: route.host, Connection: "close" },
          agent: false, rejectUnauthorized: true, ...(ca === undefined ? {} : { ca }), signal: AbortSignal.timeout(timeoutMs),
        }, (response) => {
          const code = response.statusCode ?? 0;
          // Readiness is a status contract. Do not buffer an app's response body.
          resolve(result(code >= 200 && code < 400 ? "ready" : "unready"));
          response.destroy();
        });
        probe.once("error", () => { resolve(result("unavailable")); });
        probe.end();
      });
    },
  }));
};
