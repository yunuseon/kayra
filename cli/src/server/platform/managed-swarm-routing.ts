import { createHash } from "node:crypto";
import { parseManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import type { ManagedApplicationPlan } from "../../contracts/managed-application-plan.ts";
import { typed } from "../../lib/typed.ts";

const identity = (parts: readonly unknown[]) => "kayra-" + createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

/** Platform policy only. Stable route identities prevent unrelated additions from renaming existing routers. */
export const managedSwarmRouting = (input: ManagedApplicationPlan, service: string) => {
  const checked = parseManagedApplicationPlan(input); if (!checked.ok) throw new Error("invalid managed routing plan");
  const plan = checked.value; const spec = plan.services[service]; if (spec === undefined) throw new Error("managed routing service is missing");
  if (spec.role !== "http") return typed<Readonly<Record<string, string>>>(Object.freeze({}));
  const owner = plan.infrastructure.ownership;
  return Object.freeze(Object.fromEntries(plan.routes.filter((route) => route.service === service).flatMap((route) => {
    const name = identity([owner.app, owner.incarnation, route.host, route.path]);
    const router = `traefik.http.routers.${name}`; const backend = identity([owner.app, owner.incarnation, service, route.port]); const limit = name + "-limit";
    return typed<readonly (readonly [string, string])[]>([
      ["traefik.enable", "true"], ["traefik.swarm.network", plan.host.network.name], ["traefik.swarm.lbswarm", "true"],
      [`${router}.rule`, [`Host(\`${route.host}\`)`, ...(route.path === null ? [] : [`PathPrefix(\`${route.path}\`)`])].join(" && ")],
      [`${router}.entrypoints`, "websecure"], [`${router}.tls.certresolver`, "le"], [`${router}.service`, backend],
      [`traefik.http.services.${backend}.loadbalancer.server.port`, String(route.port)],
      ...(route.rateLimit === null ? [] : typed<readonly (readonly [string, string])[]>([
        [`${router}.middlewares`, limit], [`traefik.http.middlewares.${limit}.ratelimit.average`, String(route.rateLimit.average)],
        [`traefik.http.middlewares.${limit}.ratelimit.period`, route.rateLimit.period], [`traefik.http.middlewares.${limit}.ratelimit.burst`, String(route.rateLimit.burst)],
      ])),
    ]);
  })));
};
