import { all, attempt, err, flatMap, ok } from "../../lib/result.ts";
import { typed } from "../../lib/typed.ts";
import { field } from "../app.ts";
import { period, port, routePath, serviceName, subdomain, type AppName, type Period, type Port, type RoutePath, type ServiceName, type Subdomain } from "../brand.ts";

/** Traefik's rateLimit, keyed on the client's address. */
export type RateLimit = { readonly average: number; readonly period: Period; readonly burst: number };

/** One of an app's public routes (app.yml `routes`): `<host>.<domain>`, under `path` if given, to a service's port. */
export type Route = {
  readonly host: Subdomain;
  readonly path: RoutePath | undefined;
  readonly service: ServiceName;
  readonly port: Port;
  readonly rateLimit: RateLimit | undefined;
  /** A path that answers 2xx or 3xx once the app is ready. */
  readonly check: RoutePath | undefined;
};

const unknownKey = (value: object, known: readonly string[]) => Object.keys(value).find((key) => !known.includes(key));

const count = (value: unknown, name: string) =>
  typeof value === "number" && Number.isInteger(value) && value > 0 ? ok<number>(value) : err(`${name} ${String(value)} is not a positive whole number`);

const text = (value: unknown, name: string) => (typeof value === "string" ? ok<string>(value) : err(`${name} is missing or not text`));

const rateLimit = (value: unknown) => {
  if (value === undefined) return ok<RateLimit | undefined>(undefined);
  if (typeof value !== "object" || value === null) return err("rate_limit is not a mapping");
  const extra = unknownKey(value, ["average", "period", "burst"]);
  if (extra !== undefined) return err(`rate_limit.${extra} is not a rate limit field`);
  const average = count(field(value, "average"), "rate_limit.average");
  const burst = count(field(value, "burst"), "rate_limit.burst");
  const per = flatMap(text(field(value, "period"), "rate_limit.period"), period);
  if (!average.ok) return average;
  if (!burst.ok) return burst;
  if (!per.ok) return per;
  return ok<RateLimit | undefined>({ average: average.value, period: per.value, burst: burst.value });
};

const optionalPath = (value: unknown, name: string) =>
  value === undefined ? ok<RoutePath | undefined>(undefined) : flatMap(text(value, name), routePath);

const route = (value: unknown, index: number) => {
  const where = (problem: string) => `route ${String(index)}: ${problem}`;
  if (typeof value !== "object" || value === null) return err(where("not a mapping"));
  const extra = unknownKey(value, ["host", "path", "service", "port", "rate_limit", "check"]);
  if (extra !== undefined) return err(where(`${extra} is not a route field`));
  const host = flatMap(text(field(value, "host"), "host"), subdomain);
  const service = flatMap(text(field(value, "service"), "service"), serviceName);
  const rawPort = field(value, "port");
  const listens = typeof rawPort === "number" ? port(rawPort) : err(`port ${String(rawPort)} is not a port`);
  const path = optionalPath(field(value, "path"), "path");
  const check = optionalPath(field(value, "check"), "check");
  const limit = rateLimit(field(value, "rate_limit"));
  if (!host.ok) return err(where(host.error));
  if (!service.ok) return err(where(service.error));
  if (!listens.ok) return err(where(listens.error));
  if (!path.ok) return err(where(path.error));
  if (!check.ok) return err(where(check.error));
  if (!limit.ok) return err(where(limit.error));
  return ok<Route>({ host: host.value, path: path.value, service: service.value, port: listens.value, rateLimit: limit.value, check: check.value });
};

/** A route's readiness URL: its check path, or its own path. */
export const readinessUrl = (route: Route, domain: string) => `https://${route.host}.${domain}${route.check ?? route.path ?? "/"}`;

/** app.yml's routes as the builder read them at the commit: untrusted, so every field is checked. */
export const parseRoutes = (json: unknown) =>
  Array.isArray(json) ? all(json.map((item: unknown, index) => route(item, index))) : err("routes is not a list");

/** A route as app.yml writes it. */
type WireRoute = {
  readonly host: Subdomain;
  readonly path?: RoutePath;
  readonly service: ServiceName;
  readonly port: Port;
  readonly rate_limit?: RateLimit;
};

/** Routes as app.yml writes them, for the compose policy. */
export const wireRoutes = (routes: readonly Route[]) =>
  Object.freeze(
    routes.map((route) =>
      typed<WireRoute>({
        host: route.host,
        ...(route.path === undefined ? {} : { path: route.path }),
        service: route.service,
        port: route.port,
        ...(route.rateLimit === undefined ? {} : { rate_limit: route.rateLimit }),
      }),
    ),
  );

/** One line for the run's log: `www → web:3000, api/signup → api:3000 (rate limited)`. */
export const describeRoutes = (routes: readonly Route[]) =>
  routes.length === 0
    ? "none"
    : routes
        .map((route) => `${route.host}${route.path ?? ""} → ${route.service}:${String(route.port)}${route.rateLimit === undefined ? "" : " (rate limited)"}`)
        .join(", ");

/** A router per route: unique on the server through the app's prefix, readable in Traefik's dashboard. */
const routerName = (app: AppName, index: number, route: Route) => `${app}-${String(index)}-${route.host}`;

/** A Traefik service per service and port, so one container can serve two ports. */
const backendName = (app: AppName, route: Route) => `${app}-${route.service}-${String(route.port)}`;

const rule = (route: Route, domain: string) =>
  [`Host(\`${route.host}.${domain}\`)`, ...(route.path === undefined ? [] : [`PathPrefix(\`${route.path}\`)`])].join(" && ");

/** A route's labels. Security headers need none: the websecure entrypoint gives them to every router. */
const routeLabels = (app: AppName, domain: string, route: Route, index: number) => {
  const router = `traefik.http.routers.${routerName(app, index, route)}`;
  const limit = `${routerName(app, index, route)}-limit`;
  const backend = backendName(app, route);
  return typed<readonly (readonly [string, string])[]>([
    [`${router}.rule`, rule(route, domain)],
    [`${router}.entrypoints`, "websecure"],
    [`${router}.tls.certresolver`, "le"],
    [`${router}.service`, backend],
    [`traefik.http.services.${backend}.loadbalancer.server.port`, String(route.port)],
    ...(route.rateLimit === undefined
      ? []
      : ([
          [`${router}.middlewares`, limit],
          [`traefik.http.middlewares.${limit}.ratelimit.average`, String(route.rateLimit.average)],
          [`traefik.http.middlewares.${limit}.ratelimit.period`, route.rateLimit.period],
          [`traefik.http.middlewares.${limit}.ratelimit.burst`, String(route.rateLimit.burst)],
        ] as const)),
  ]);
};

/** The networks the admitted config gives a service; Compose spells out the implicit default. */
const networksOf = (config: unknown, service: ServiceName) => {
  const services = typeof config === "object" && config !== null ? field(config, "services") : undefined;
  const definition = typeof services === "object" && services !== null ? field(services, service) : undefined;
  if (typeof definition !== "object" || definition === null) return err(`route to ${service}: no such service in the compose files`);
  const networks = field(definition, "networks");
  return ok<Readonly<Record<string, unknown>>>(typeof networks === "object" && networks !== null ? { ...networks } : { default: null });
};

/**
 * The platform's part of an app's compose project, from its admitted config
 * and its routes: each routed service joins platform-public, beside the
 * networks it has (restated, or the override would replace them), and gets the
 * Traefik labels its routes become. Apps write no Traefik label themselves:
 * the policy refuses them.
 */
export const routesOverride = (app: AppName, domain: string, routes: readonly Route[], admitted: string) =>
  flatMap(
    attempt(() => ok<unknown>(JSON.parse(admitted)), (why) => `the admitted config is not JSON: ${why}`),
    (config) => {
      const routed = [...new Set(routes.map((route) => route.service))];
      const services = all(
        routed.map((service) =>
          flatMap(networksOf(config, service), (networks) =>
            ok<readonly [string, unknown]>([
              service,
              {
                networks: { ...networks, "platform-public": null },
                labels: Object.fromEntries([
                  ["traefik.enable", "true"],
                  ["traefik.docker.network", "platform-public"],
                  ...routes.flatMap((route, index) => (route.service === service ? routeLabels(app, domain, route, index) : [])),
                ]),
              },
            ]),
          ),
        ),
      );
      return flatMap(services, (entries) =>
        ok<string>(
          `${JSON.stringify(
            {
              services: Object.fromEntries(entries),
              ...(entries.length === 0 ? {} : { networks: { "platform-public": { name: "platform-public", external: true } } }),
            },
            null,
            2,
          )}\n`,
        ),
      );
    },
  );
