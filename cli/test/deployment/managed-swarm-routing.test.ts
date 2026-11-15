import { strict as assert } from "node:assert";
import { test } from "node:test";
import { managedPlanFixture } from "./managed-plan-fixture.ts";
import { parseManagedApplicationPlan } from "../../src/contracts/managed-application-plan.ts";
import { managedServiceDigest, managedServiceName } from "../../src/contracts/managed-service-plan.ts";
import { managedSwarmRouting } from "../../src/server/platform/managed-swarm-routing.ts";
import { prepareManagedTransition } from "../../src/server/deployment/managed-transition.ts";

const clock = () => ({ deadline: Date.now() + 1000, now: Date.now });
const unchanged = { compare: () => Promise.resolve("unchanged" as const) };

test("managed routing is scoped per HTTP service and route additions preserve existing label identities", async () => {
  const { plan } = await managedPlanFixture(); const web = plan.services["web"]; const route = plan.routes[0]; assert.ok(web && route);
  const original = managedSwarmRouting(plan, "web");
  const candidate = parseManagedApplicationPlan({ ...plan, hosts: [...plan.hosts, "api.lab.test"],
    services: { ...plan.services, api: { ...web, service: "api", nativeName: managedServiceName(web.owner, "api") } },
    rollout: { ...plan.rollout, services: { ...plan.rollout.services, api: { role: "http", overlap: "allowed" } } },
    routes: [...plan.routes, { ...route, host: "api.lab.test", service: "api", port: 3000, rateLimit: { average: 10, period: "1s", burst: 20 } }],
  }); assert.ok(candidate.ok);
  assert.deepEqual(managedSwarmRouting(candidate.value, "web"), original);
  const api = managedSwarmRouting(candidate.value, "api");
  assert.equal(api["traefik.swarm.lbswarm"], "true"); assert.equal(api["traefik.swarm.network"], "platform-swarm");
  assert.ok(Object.values(api).includes("Host(`api.lab.test`)")); assert.equal(Object.values(api).includes("Host(`www.lab.test`)"), false);
  assert.ok(Object.entries(api).some(([key, value]) => key.endsWith(".ratelimit.average") && value === "10"));
  assert.deepEqual(managedSwarmRouting(candidate.value, "worker"), {}); assert.deepEqual(managedSwarmRouting(candidate.value, "db"), {});
  assert.throws(() => managedSwarmRouting(candidate.value, "missing"), /missing/);
});

test("routing-only policy changes require a workload replacement despite an unchanged service digest", async () => {
  const { plan } = await managedPlanFixture(); const route = plan.routes[0]; assert.ok(route);
  const candidate = parseManagedApplicationPlan({ ...plan, routes: [{ ...route, rateLimit: { average: 10, period: "1s", burst: 20 } }] }); assert.ok(candidate.ok);
  const before = plan.services["web"]; const after = candidate.value.services["web"]; assert.ok(before && after); assert.equal(managedServiceDigest(before), managedServiceDigest(after));
  const transition = await prepareManagedTransition(plan, candidate.value, [], unchanged, clock()); assert.ok(transition.ok);
  assert.equal(transition.value.changes.find((value) => value.name === "web")?.kind, "replace");
});

test("native rolling cannot move an existing route between services; granted maintenance may do so", async () => {
  const { plan } = await managedPlanFixture(); const web = plan.services["web"]; const route = plan.routes[0]; assert.ok(web && route);
  const candidate = parseManagedApplicationPlan({ ...plan,
    services: { ...plan.services, api: { ...web, service: "api", nativeName: managedServiceName(web.owner, "api") } },
    rollout: { ...plan.rollout, services: { ...plan.rollout.services, api: { role: "http", overlap: "allowed" } } },
    routes: [{ ...route, service: "api" }, { ...route, path: "/other" }],
  }); assert.ok(candidate.ok);
  const rolling = await prepareManagedTransition(plan, candidate.value, [], unchanged, clock()); assert.ok(!rolling.ok); assert.match(rolling.error, /move an existing route/);
  const maintenance = parseManagedApplicationPlan({ ...candidate.value, grants: { ...candidate.value.grants, maintenance: true }, rollout: { ...candidate.value.rollout, strategy: "maintenance" } }); assert.ok(maintenance.ok);
  assert.ok((await prepareManagedTransition(plan, maintenance.value, [], unchanged, clock())).ok);
});
