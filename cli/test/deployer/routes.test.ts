import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { describeRoutes, parseRoutes, routesOverride } from "../../src/deployer/build/routes.ts";
import { must, name } from "./support.ts";

const shop = name("shop");

test("routes are checked, not trusted: fields, hosts, paths, ports, rate limits", () => {
  const routes = must(parseRoutes([
    { host: "www", service: "web", port: 3000 },
    { host: "api", path: "/signup", service: "api", port: 8080, rate_limit: { average: 20, period: "10m", burst: 5 } },
  ]));
  strictEqual(describeRoutes(routes), "www → web:3000, api/signup → api:8080 (rate limited)");
  strictEqual(describeRoutes([]), "none");
  const refused = (route: unknown) => {
    const parsed = parseRoutes([route]);
    return parsed.ok ? "admitted" : parsed.error;
  };
  strictEqual(parseRoutes({ host: "www" }).ok, false);
  strictEqual(refused({ host: "www", service: "web", port: 3000, middlewares: "other-auth@docker" }), "route 0: middlewares is not a route field");
  strictEqual(refused({ host: "www.other.com", service: "web", port: 3000 }), "route 0: 'www.other.com' is not a subdomain");
  strictEqual(refused({ host: "www", service: "web", port: 0 }), "route 0: 0 is not a port");
  strictEqual(refused({ host: "www", service: "web", port: "3000" }), "route 0: port 3000 is not a port");
  strictEqual(refused({ host: "www", path: "/a`) || Host(`evil.com", service: "web", port: 3000 }).startsWith("route 0: '/a`)"), true);
  strictEqual(refused({ host: "www", path: "/${SECRET}", service: "web", port: 3000 }).startsWith("route 0: '/${SECRET}'"), true);
  strictEqual(refused({ host: "www", path: "no-slash", service: "web", port: 3000 }).startsWith("route 0: 'no-slash'"), true);
  strictEqual(refused({ host: "www", service: "web", port: 3000, rate_limit: { average: 20, period: "10 minutes", burst: 5 } }).startsWith("route 0: '10 minutes'"), true);
  strictEqual(refused({ host: "www", service: "web", port: 3000, rate_limit: { average: 20, period: "10m" } }), "route 0: rate_limit.burst undefined is not a positive whole number");
});

const admitted = JSON.stringify({
  services: {
    web: { image: "localhost:5000/shop/web:0123456789ab", networks: { default: null } },
    api: { image: "localhost:5000/shop/api:0123456789ab", networks: { private: { aliases: ["backend"] }, default: {} } },
    db: { image: "postgres:16", networks: { private: null } },
  },
});

const override = (routes: unknown) => {
  const written: unknown = JSON.parse(must(routesOverride(shop, "shop.example.com", must(parseRoutes(routes)), admitted)));
  return written;
};

test("the override: routed services join platform-public beside their own networks; the rest untouched", () => {
  deepStrictEqual(override([{ host: "www", service: "web", port: 3000 }]), {
    services: {
      web: {
        networks: { default: null, "platform-public": null },
        labels: {
          "traefik.enable": "true",
          "traefik.docker.network": "platform-public",
          "traefik.http.routers.shop-0-www.rule": "Host(`www.shop.example.com`)",
          "traefik.http.routers.shop-0-www.entrypoints": "websecure",
          "traefik.http.routers.shop-0-www.tls.certresolver": "le",
          "traefik.http.routers.shop-0-www.service": "shop-web-3000",
          "traefik.http.services.shop-web-3000.loadbalancer.server.port": "3000",
        },
      },
    },
    networks: { "platform-public": { name: "platform-public", external: true } },
  });
});

test("the override: a path route with a rate limit beside its host's route, two ports on one service", () => {
  deepStrictEqual(
    override([
      { host: "api", service: "api", port: 3000 },
      { host: "api", path: "/signup", service: "api", port: 3000, rate_limit: { average: 20, period: "10m", burst: 5 } },
      { host: "metrics", service: "api", port: 9090 },
    ]),
    {
      services: {
        api: {
          networks: { private: { aliases: ["backend"] }, default: {}, "platform-public": null },
          labels: {
            "traefik.enable": "true",
            "traefik.docker.network": "platform-public",
            "traefik.http.routers.shop-0-api.rule": "Host(`api.shop.example.com`)",
            "traefik.http.routers.shop-0-api.entrypoints": "websecure",
            "traefik.http.routers.shop-0-api.tls.certresolver": "le",
            "traefik.http.routers.shop-0-api.service": "shop-api-3000",
            "traefik.http.services.shop-api-3000.loadbalancer.server.port": "3000",
            "traefik.http.routers.shop-1-api.rule": "Host(`api.shop.example.com`) && PathPrefix(`/signup`)",
            "traefik.http.routers.shop-1-api.entrypoints": "websecure",
            "traefik.http.routers.shop-1-api.tls.certresolver": "le",
            "traefik.http.routers.shop-1-api.service": "shop-api-3000",
            "traefik.http.routers.shop-1-api.middlewares": "shop-1-api-limit",
            "traefik.http.middlewares.shop-1-api-limit.ratelimit.average": "20",
            "traefik.http.middlewares.shop-1-api-limit.ratelimit.period": "10m",
            "traefik.http.middlewares.shop-1-api-limit.ratelimit.burst": "5",
            "traefik.http.routers.shop-2-metrics.rule": "Host(`metrics.shop.example.com`)",
            "traefik.http.routers.shop-2-metrics.entrypoints": "websecure",
            "traefik.http.routers.shop-2-metrics.tls.certresolver": "le",
            "traefik.http.routers.shop-2-metrics.service": "shop-api-9090",
            "traefik.http.services.shop-api-9090.loadbalancer.server.port": "9090",
          },
        },
      },
      networks: { "platform-public": { name: "platform-public", external: true } },
    },
  );
});

test("the override: no routes, nothing routed; a route to a missing service refused", () => {
  deepStrictEqual(override([]), { services: {} });
  deepStrictEqual(routesOverride(shop, "shop.example.com", must(parseRoutes([{ host: "www", service: "cache", port: 3000 }])), admitted).ok, false);
  deepStrictEqual(routesOverride(shop, "shop.example.com", [], "not json").ok, false);
});
