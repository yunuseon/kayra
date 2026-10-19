import { err, ok } from "../../result.ts";
import { field } from "../app.ts";
import { sha, type AppName, type Sha } from "../brand.ts";
import { typed } from "../../typed.ts";

/** One built artifact: the compose variable naming it and the content-addressed ref the host daemon pulls. */
export type Image = { readonly variable: string; readonly ref: string };
export type ComposeFile = { readonly path: string; readonly content: string };

/**
 * What the builder hands the deployer for one commit: the images it made sure
 * exist and the compose files app.yml lists at that commit. The builder runs
 * next to untrusted code, so the deployer trusts none of it: every field is
 * checked here, and the compose files still go through admission.
 */
export type Bundle = { readonly sha: Sha; readonly images: readonly Image[]; readonly compose: readonly ComposeFile[] };

const relative = (path: string) =>
  path !== "" && !path.startsWith("/") && !path.split("/").some((segment) => segment === ".." || segment === "");

export const parseBundle = (app: AppName, expected: Sha, json: unknown) => {
  if (typeof json !== "object" || json === null) return err("bundle: not an object");
  const commit = field(json, "sha");
  const images = field(json, "images");
  const compose = field(json, "compose");
  const minted = sha(typeof commit === "string" ? commit : "");
  if (!minted.ok || minted.value !== expected) return err(`bundle: for ${String(commit)}, not ${expected}`);
  if (!Array.isArray(images) || !Array.isArray(compose) || compose.length === 0) return err("bundle: images or compose missing");
  const own = new RegExp(`^localhost:5000/${app}/[a-z0-9._/-]+:[0-9a-f]{12}$`);
  const parsedImages = images.map((image: unknown) => {
    if (typeof image !== "object" || image === null) return typed<Image | string>("an image is not an object");
    const variable = field(image, "variable");
    const ref = field(image, "ref");
    if (typeof variable !== "string" || !/^[A-Z][A-Z0-9_]*_IMAGE$/.test(variable)) return `image variable ${String(variable)}`;
    if (typeof ref !== "string" || !own.test(ref)) return `image ${String(ref)} is outside ${app}/`;
    return typed<Image | string>({ variable, ref });
  });
  const parsedCompose = compose.map((file: unknown) => {
    if (typeof file !== "object" || file === null) return typed<ComposeFile | string>("a compose file is not an object");
    const path = field(file, "path");
    const content = field(file, "content");
    if (typeof path !== "string" || !relative(path)) return `compose file ${String(path)}`;
    if (typeof content !== "string") return `compose file ${path} has no content`;
    return typed<ComposeFile | string>({ path, content });
  });
  const problem = [...parsedImages, ...parsedCompose].find((item) => typeof item === "string");
  if (problem !== undefined) return err(`bundle: ${problem}`);
  return ok<Bundle>({
    sha: minted.value,
    images: parsedImages.filter((item) => typeof item !== "string"),
    compose: parsedCompose.filter((item) => typeof item !== "string"),
  });
};

/** images.env, as compose reads it next to the app's own .env. */
export const imagesEnv = (bundle: Bundle) => bundle.images.map((image) => `${image.variable}=${image.ref}\n`).join("");
