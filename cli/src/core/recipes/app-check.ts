import { appName, within, type AbsolutePath, type KayraRoot } from "../fleet/brand.ts";
import { yamlOf } from "../fleet/parse.ts";
import { run, type Plan, type Step } from "../plan/model.ts";
import { err, flatMap, map, mapError, type Result } from "../../result.ts";
import { appManifestSchema } from "../fleet/settings.ts";
import { checkShape } from "../fleet/shape.ts";
import { onPath } from "./steps.ts";


const tool = (program: string, hint: string): Step => onPath(`${program} is installed`, program, hint, "stop");

/**
 * In an app's own repository, before a push: what the platform checks when it
 * deploys the app — app.yml against its schema here, then app-check.sh (the
 * image plan and the compose policy, the same scripts the builder and the
 * deployer run). Needs no fleet and no server.
 */
export const appCheck = (kayra: KayraRoot, root: AbsolutePath, manifest: string | undefined): Result<Plan, string> => {
  if (manifest === undefined) return err(`no app.yml in ${root}`);
  const shaped = flatMap(
    flatMap(
      mapError(yamlOf(manifest), (problem) => `app.yml ${problem}`),
      (values) => checkShape("app.yml", values, appManifestSchema),
    ),
    (values) => {
      const parsed = appManifestSchema.safeParse(values);
      return parsed.success ? appName(parsed.data.name) : err("app.yml: invalid");
    },
  );
  return map(shaped, (): Plan => [
    tool("git", "brew install git"),
    tool("jq", "brew install jq"),
    tool("yq", "brew install yq"),
    tool("docker", "the docker CLI with Compose; no daemon is needed"),
    run("Image plan and compose policy", ["bash", within(kayra, "scripts", "local", "app-check.sh"), root]),
  ]);
};
