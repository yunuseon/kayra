import { within, type AbsolutePath, type KayraRoot } from "../fleet/brand.ts";
import { yamlOf } from "../../lib/yaml.ts";
import { type Plan, run } from "../plan/model.ts";
import { err, flatMap, map, mapError } from "../../lib/result.ts";
import { appManifestSchema } from "../fleet/settings.ts";
import { checkShape } from "../fleet/shape.ts";
import { onPath } from "./steps.ts";
import { typed } from "../../lib/typed.ts";


const tool = (program: string, hint: string) => onPath(`${program} is installed`, program, hint, "stop");

/**
 * In an app's own repository, before a push: what the platform checks when it
 * deploys the app — app.yml against its schema here, then app-check.sh (the
 * image plan and the compose policy, the same scripts the builder and the
 * deployer run). Needs no fleet and no server.
 */
/**
 * In an existing project without app.yml: what app init writes (app.yml, an
 * overlay of the project's compose file, an image manifest per built service),
 * then the same check as app check, which names what is left to do.
 */
export const appInit = (kayra: KayraRoot, root: AbsolutePath, name: string | undefined) => typed<Plan>([
  tool("git", "brew install git"),
  tool("jq", "brew install jq"),
  tool("yq", "brew install yq"),
  tool("docker", "the docker CLI with Compose; no daemon is needed"),
  run("Write app.yml and the platform's overlay", [process.execPath, within(kayra, "bin", "kayra-app-init.js"), JSON.stringify({ root, ...(name === undefined ? {} : { name }) })]),
  run("Image plan and compose policy", ["bash", within(kayra, "scripts", "local", "app-check.sh"), root]),
]);

export const appCheck = (kayra: KayraRoot, root: AbsolutePath, manifest: string | undefined) => {
  if (manifest === undefined) return err(`no app.yml in ${root}`);
  const shaped = flatMap(
    mapError(yamlOf(manifest), (problem) => `app.yml ${problem}`),
    (values) => map(checkShape("app.yml", values, appManifestSchema), () => manifest),
  );
  return map(shaped, () => typed<Plan>([
    tool("git", "brew install git"),
    tool("jq", "brew install jq"),
    tool("yq", "brew install yq"),
    tool("docker", "the docker CLI with Compose; no daemon is needed"),
    run("Image plan and compose policy", ["bash", within(kayra, "scripts", "local", "app-check.sh"), root]),
  ]));
};
