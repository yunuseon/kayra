import { typed } from "../../lib/typed.ts";

type Env = Readonly<Record<string, string>>;

export const renovate = (env: Env, dryRun: boolean, image: string) => {
  const optional = ["RENOVATE_ENDPOINT", "RENOVATE_GIT_URL", "RENOVATE_HOST_RULES", "RENOVATE_GITHUB_COM_TOKEN"]
    .filter((key) => (env[key] ?? "") !== "")
    .flatMap((key) => ["-e", key] as const);
  return typed<readonly [string, ...string[]]>([
    "docker", "run", "--rm", "--network", "platform-internal",
    "-e", "RENOVATE_TOKEN", "-e", "RENOVATE_PLATFORM", ...optional, "-e", "RENOVATE_REPOSITORIES",
    "-e", `RENOVATE_DRY_RUN=${dryRun ? "full" : "null"}`, "-e", "LOG_LEVEL=info",
    image,
  ]);
};

export type Maintenance = { readonly job: "gc" | "renovate"; readonly dryRun: boolean };
export type MaintenanceSettings = { readonly platformDir: string; readonly gcScript: string; readonly renovateImage: string; readonly env: Env };
export type MaintenanceEffects = {
  readonly token: (name: string) => string;
  readonly exec: (argv: readonly [string, ...string[]], options: { readonly cwd: string; readonly env: Env }) => Promise<{ readonly code: number }>;
};

export const runMaintenance = async (work: Maintenance, settings: MaintenanceSettings, effects: MaintenanceEffects) => {
  const argv = work.job === "gc" ? (["bash", settings.gcScript] as const) : renovate(settings.env, work.dryRun, settings.renovateImage);
  const env: Env = work.job === "renovate" ? { RENOVATE_TOKEN: effects.token("RENOVATE_TOKEN") } : {};
  const exit = await effects.exec(argv, { cwd: settings.platformDir, env });
  return { ok: exit.code === 0 } as const;
};
