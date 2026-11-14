/* eslint-disable functional/no-let -- owns bounded transport buffers and one immutable manifest selection */
import { createHash } from "node:crypto";
import { request } from "node:http";
import { z } from "zod";
import type { ImageAdmissionPort } from "../../contracts/image-admission.ts";
import { typed } from "../../lib/typed.ts";
import { imageJson } from "./image-json.ts";

const manifestTypes = ["application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"];
const indexTypes = ["application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json"];
const configTypes = ["application/vnd.oci.image.config.v1+json", "application/vnd.docker.container.image.v1+json"];
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const descriptor = z.object({ mediaType: z.string(), digest, size: z.number().int().positive().max(1024 * 1024) }).loose();
const index = z.object({ schemaVersion: z.literal(2), mediaType: z.string().optional(), manifests: z.array(descriptor.extend({ platform: z.object({
  os: z.string(), architecture: z.string(), variant: z.string().optional(), "os.features": z.array(z.string()).optional(), features: z.array(z.string()).optional(),
}).loose().optional() })).max(128), config: z.never().optional() }).loose();
const manifest = z.object({ schemaVersion: z.literal(2), mediaType: z.string().optional(), config: descriptor, manifests: z.never().optional(), layers: z.array(z.unknown()).max(1024) }).loose();
const configuration = z.object({ os: z.string(), architecture: z.string(), "os.features": z.array(z.string()).optional(),
  config: z.object({ Volumes: z.record(z.string(), z.unknown()).nullable().optional() }).loose().nullable().optional(),
}).loose();
const hash = (bytes: unknown) => {
  if (!Buffer.isBuffer(bytes)) throw new Error("image metadata bytes are unavailable");
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
};
const maximum = 1024 * 1024;

/** Existing private registry only. Fixed repository paths; no descriptor URLs, redirects, retries or Docker writes. */
export const registryImages = (origin = "http://registry:5000", architecture = process.arch === "x64" ? "amd64" : process.arch, now: () => number = Date.now) => {
  const endpoint = new URL(origin);
  if (endpoint.protocol !== "http:" || endpoint.username !== "" || endpoint.password !== "" || endpoint.pathname !== "/" || endpoint.search !== "" || endpoint.hash !== "") throw new Error("invalid trusted registry endpoint");
  const get = async (path: string, expected: string, size: number | undefined, deadline: number) => {
    const left = deadline - now(); if (!Number.isSafeInteger(left) || left <= 0) throw new Error("image metadata deadline expired");
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const operation = request(new URL(path, endpoint), { method: "GET", agent: false, signal: AbortSignal.timeout(left), headers: { Accept: [...manifestTypes, ...indexTypes].join(", "), "Accept-Encoding": "identity" } }, (response) => {
        if (response.statusCode !== 200) { response.resume(); reject(new Error("image metadata unavailable")); operation.destroy(); return; }
        const chunks: Buffer[] = []; let length = 0;
        response.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > maximum || size !== undefined && length > size) { reject(new Error("image metadata exceeds limit")); operation.destroy(); return; }
          // eslint-disable-next-line functional/immutable-data -- private bounded response buffer
          chunks.push(chunk);
        });
        response.on("error", () => { reject(new Error("image metadata interrupted")); });
        response.on("end", () => { resolve(Buffer.concat(chunks, length)); });
      });
      operation.on("error", () => { reject(new Error("image metadata unavailable")); }); operation.end();
    });
    if (hash(bytes) !== expected || size !== undefined && bytes.length !== size || now() >= deadline) throw new Error("image metadata integrity or deadline failed");
    return imageJson(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  };
  return typed<ImageAdmissionPort>(Object.freeze({ verify: async (app, images) => {
    if (!["amd64", "arm64"].includes(architecture) || !/^[a-z][a-z0-9-]{0,47}$/.test(app) || images.length === 0 || images.length > 128) return "unsupported";
    const component = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
    const owned = new RegExp(`^localhost:5000/(${app}/${component}(?:/${component})*)@(sha256:[0-9a-f]{64})$`);
    const references = [...new Set(images)].map((image) => { const match = owned.exec(image); return match === null ? null : Object.freeze({ repository: match[1], digest: match[2] }); });
    if (references.some((reference) => reference === null)) return "unsupported";
    const deadline = now() + 10_000;
    try {
      for (const reference of references) {
        const repository = reference?.repository; const identity = reference?.digest; if (repository === undefined || identity === undefined) return "unsupported";
        const path = `/v2/${repository}/`; let raw = await get(path + "manifests/" + identity, identity, undefined, deadline);
        const list = index.safeParse(raw);
        if (list.success) {
          if (list.data.mediaType !== undefined && !indexTypes.includes(list.data.mediaType)) return "unsupported";
          const matching = list.data.manifests.filter((item) => item.platform?.os === "linux" && item.platform.architecture === architecture);
          const selected = matching[0]; const platform = selected?.platform;
          if (matching.length !== 1 || selected === undefined || platform === undefined || !manifestTypes.includes(selected.mediaType) ||
            platform.variant !== undefined && !(architecture === "arm64" && platform.variant === "v8") || (platform["os.features"]?.length ?? 0) > 0 || (platform.features?.length ?? 0) > 0) return "unsupported";
          raw = await get(path + "manifests/" + selected.digest, selected.digest, selected.size, deadline);
        }
        const leaf = manifest.safeParse(raw);
        if (!leaf.success || leaf.data.mediaType !== undefined && !manifestTypes.includes(leaf.data.mediaType) || !configTypes.includes(leaf.data.config.mediaType)) return "unsupported";
        const config = configuration.safeParse(await get(path + "blobs/" + leaf.data.config.digest, leaf.data.config.digest, leaf.data.config.size, deadline));
        if (!config.success || config.data.os !== "linux" || config.data.architecture !== architecture || (config.data["os.features"]?.length ?? 0) > 0 || Object.keys(config.data.config?.Volumes ?? {}).length > 0) return "unsupported";
      }
      return now() < deadline ? "accepted" : "unavailable";
    } catch { return "unavailable"; }
  } }));
};
