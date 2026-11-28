import { typed } from "../../lib/typed.ts";
import type { ApplicationPlan } from "../../contracts/http-plan.ts";

/** Generated platform policy only; apps cannot submit Docker or Traefik labels. */
export const swarmRouting = (plan: ApplicationPlan) => Object.freeze(Object.fromEntries(plan.routes.flatMap((route, index) => {
  const name = `kayra-${plan.app}-${String(index)}`;
  const router = `traefik.http.routers.${name}`;
  const backend = `kayra-${plan.app}-${route.service}-${String(route.port)}`;
  const limit = `${name}-limit`;
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
