import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { test } from "node:test";
import { assess, memoryAvailable, parseContainers, type HealthFacts } from "../../src/deployer/health.ts";

const well: HealthFacts = {
  containers: parseContainers(
    [
      "platform|platform-traefik-1|running|Up 3 days",
      "platform|platform-authelia-1|running|Up 3 days (healthy)",
      "shop|shop-web-1|running|Up 2 hours (healthy)",
      "shop|shop-migrate-1|exited|Exited (0) 2 hours ago",
      "|stray|exited|Exited (1) 9 days ago",
      "",
    ].join("\n"),
  ),
  apps: [{ name: "shop", released: true }, { name: "blog", released: false }],
  diskUsed: 0.42,
  memoryAvailable: 0.6,
};

test("health: well when every container runs, a one-shot exited 0, an app never deployed has none; strangers ignored", () => {
  deepStrictEqual(assess(well), { healthy: true, problems: [], warnings: [] });
});

test("health: an unhealthy, starting or crashed container, a deployed app without containers, Docker silent", () => {
  const sick = assess({
    ...well,
    containers: parseContainers(
      ["platform|platform-traefik-1|running|Up 3 days (unhealthy)", "shop|shop-web-1|exited|Exited (137) 1 minute ago", "blog|blog-web-1|running|Up 5 seconds (health: starting)"].join("\n"),
    ),
  });
  strictEqual(sick.healthy, false);
  deepStrictEqual(sick.problems, [
    "platform: platform-traefik-1 Up 3 days (unhealthy)",
    "shop: shop-web-1 Exited (137) 1 minute ago",
    "blog: blog-web-1 Up 5 seconds (health: starting)",
  ]);
  deepStrictEqual(assess({ ...well, containers: parseContainers("platform|platform-traefik-1|running|Up 3 days") }).problems, ["shop: no containers"]);
  deepStrictEqual(assess({ ...well, containers: undefined }).problems, ["docker did not answer"]);
});

test("health: the disk warns at 80% and fails at 90%, memory warns under 10% available and fails under 5%", () => {
  deepStrictEqual(assess({ ...well, diskUsed: 0.85, memoryAvailable: 0.08 }), { healthy: true, problems: [], warnings: ["disk 85% full", "memory 8% available"] });
  deepStrictEqual(assess({ ...well, diskUsed: 0.93, memoryAvailable: 0.03 }), { healthy: false, problems: ["disk 93% full", "memory 3% available"], warnings: [] });
});

test("memory: MemAvailable over MemTotal; unreadable counts as plenty", () => {
  strictEqual(memoryAvailable("MemTotal:        4000000 kB\nMemFree:          100000 kB\nMemAvailable:    1000000 kB\n"), 0.25);
  strictEqual(memoryAvailable(""), 1);
});

test("health consumes owned Swarm observations without guessing Compose workloads from history", () => {
  const deployment = { version: 1, app: "rollout", incarnation: "11111111-1111-4111-8111-111111111111", runtime: "swarm", scope: "runtime-services", observedAt: 1000, state: "available",
    services: [{ name: "web", state: "available", currentTasks: 1, healthyTasks: 1, ignoredHistoricalTasks: 3 }] } as const;
  const facts = { ...well, apps: [...well.apps, { name: "rollout", runtime: "swarm" as const, released: true }], deployments: [deployment], containers: [...well.containers ?? [], { project: "rollout", name: "historical-failed-task", state: "exited", status: "Exited (1)" }] };
  deepStrictEqual(assess(facts), { healthy: true, problems: [], warnings: [] });
  const unhealthy = { ...deployment, state: "unhealthy", services: [{ ...deployment.services[0], state: "unhealthy", healthyTasks: 0 }] } as const;
  deepStrictEqual(assess({ ...facts, deployments: [unhealthy] }).problems, ["rollout: current runtime unhealthy"]);
  deepStrictEqual(assess({ ...facts, deployments: [] }).problems, ["rollout: deployment observations unavailable"]);
  const conflict = { ...facts, apps: [...well.apps, { name: "rollout", runtime: "compose" as const, released: true }] };
  deepStrictEqual(assess(conflict).problems, ["rollout: runtime ownership conflicts with registration"]);
});
