import { readFileSync, statfsSync } from "node:fs";
import { typed } from "../../lib/typed.ts";

/**
 * Whether the server is well, as the deployer sees it from inside: every
 * container of the platform and of each registered app runs (none unhealthy),
 * and the disk and memory have room. Failed deploys and jobs are not here:
 * the notifier reports those, and a failed deploy leaves the last one serving.
 */
export type Container = { readonly project: string; readonly name: string; readonly state: string; readonly status: string };

export type HealthFacts = {
  /** undefined when Docker did not answer. */
  readonly containers: readonly Container[] | undefined;
  /** Each registered app, and whether it has ever deployed (a release record). */
  readonly apps: readonly { readonly name: string; readonly released: boolean }[];
  /** Fractions, 0 to 1. */
  readonly diskUsed: number;
  readonly memoryAvailable: number;
};

export type Health = { readonly healthy: boolean; readonly problems: readonly string[]; readonly warnings: readonly string[] };

const percent = (fraction: number) => `${String(Math.round(fraction * 100))}%`;

/** Like verify: a one-shot container (an init, a migration) exits 0 and stays exited. */
const unwell = (container: Container) =>
  (container.state !== "running" && !container.status.startsWith("Exited (0)")) || /unhealthy|health: starting/.test(container.status);

const containerProblems = (containers: readonly Container[], apps: HealthFacts["apps"]) =>
  Object.freeze([
    ...["platform", ...apps.map((app) => app.name)].flatMap((project) =>
      Object.freeze(containers.filter((container) => container.project === project && unwell(container)).map((container) => `${project}: ${container.name} ${container.status}`)),
    ),
    ...apps.filter((app) => app.released && !containers.some((container) => container.project === app.name)).map((app) => `${app.name}: no containers`),
  ]);

export const assess = (facts: HealthFacts) => {
  const disk = facts.diskUsed >= 0.9 ? [`disk ${percent(facts.diskUsed)} full`] : [];
  const memory = facts.memoryAvailable < 0.05 ? [`memory ${percent(facts.memoryAvailable)} available`] : [];
  const containers = facts.containers === undefined ? ["docker did not answer"] : containerProblems(facts.containers, facts.apps);
  const problems = Object.freeze([...containers, ...disk, ...memory]);
  const warnings = Object.freeze([
    ...(facts.diskUsed >= 0.8 && facts.diskUsed < 0.9 ? [`disk ${percent(facts.diskUsed)} full`] : []),
    ...(facts.memoryAvailable >= 0.05 && facts.memoryAvailable < 0.1 ? [`memory ${percent(facts.memoryAvailable)} available`] : []),
  ]);
  return typed<Health>({ healthy: problems.length === 0, problems, warnings });
};

export const parseContainers = (stdout: string) =>
  Object.freeze(
    stdout.split("\n").flatMap((line) => {
      const [project = "", name = "", state = "", status = ""] = line.split("|");
      return Object.freeze(project === "" ? [] : [typed<Container>({ project, name, state, status })]);
    }),
  );

/** MemAvailable over MemTotal, from /proc/meminfo: the host's, a container sees no other. */
export const memoryAvailable = (meminfo: string) => {
  const kib = (key: string) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(meminfo)?.[1] ?? Number.NaN);
  const fraction = kib("MemAvailable") / kib("MemTotal");
  return Number.isFinite(fraction) ? fraction : 1;
};

/** The facts on this server: `disk` is a path on the host's disk (a mount of the platform's directory). */
export const gather = async (apps: HealthFacts["apps"], disk: string, listContainers: () => Promise<{ readonly code: number; readonly stdout: string }>) => {
  const listed = await listContainers();
  const fs = statfsSync(disk);
  return typed<HealthFacts>({
    containers: listed.code === 0 ? parseContainers(listed.stdout) : undefined,
    apps,
    diskUsed: 1 - fs.bavail / fs.blocks,
    memoryAvailable: memoryAvailable(readFileSync("/proc/meminfo", "utf8")),
  });
};
