import { gather as gatherHealth, type HealthFacts } from "../server/platform/health.ts";
import { spawnLines } from "./process.ts";

export { assess, memoryAvailable, parseContainers, type Container, type Health, type HealthFacts } from "../server/platform/health.ts";

export const gather = (apps: HealthFacts["apps"], disk: string) =>
  gatherHealth(apps, disk, () => spawnLines(
    ["docker", "ps", "-a", "--format", '{{.Label "com.docker.compose.project"}}|{{.Names}}|{{.State}}|{{.Status}}'],
    { capture: true, timeoutMs: 30_000 },
    () => undefined,
  ));
