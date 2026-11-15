import { z } from "zod";
import { volumeMountTargetSchema } from "./managed-compose-description.ts";
import { err, ok } from "../lib/result.ts";

/** Adapter-owned inspection of immutable registry metadata; never pulls or creates workloads. */
export type ImageAdmissionPort = {
  readonly verify: (app: string, images: readonly string[]) => Promise<"accepted" | "unsupported" | "unavailable">;
};

const declaration = z.object({ image: z.string().min(1).max(512), kind: z.enum(["service", "one-shot"]),
  volumeTargets: z.array(volumeMountTargetSchema).max(32).readonly(),
}).strict().readonly().refine((value) => new Set(value.volumeTargets).size === value.volumeTargets.length && (value.kind === "service" || value.volumeTargets.length === 0));
const declarations = z.array(declaration).min(1).max(128).readonly();
export type ImageDeclaration = z.infer<typeof declaration>;
/** Image compatibility only: named-volume ownership, creation and admission remain separate. */
export type DeclaredImageAdmissionPort = {
  readonly verifyDeclared: (app: string, usages: readonly ImageDeclaration[]) => Promise<"accepted" | "unsupported" | "unavailable">;
};
export const parseImageDeclarations = (input: unknown) => {
  const checked = declarations.safeParse(input);
  return checked.success ? ok<readonly ImageDeclaration[]>(checked.data) : err("invalid declared image usage");
};

const pin = z.string().max(512);
const resolution = z.object({ source: pin, pull: pin, os: z.literal("linux"), architecture: z.enum(["amd64", "arm64"]) }).strict().readonly();
export type ResolvedImage = z.infer<typeof resolution>;
export type ImageResolutionResult = { readonly status: "unsupported" | "unavailable" } | { readonly status: "accepted"; readonly images: readonly ResolvedImage[] };
export type ImageResolutionPort = {
  readonly resolveDeclared: (app: string, usages: readonly ImageDeclaration[]) => Promise<ImageResolutionResult>;
};
/** Parse an app-owned immutable registry reference without selecting any platform. */
export const parseOwnedImageReference = (app: string, input: unknown) => {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(app) || typeof input !== "string" || input.length > 512) return err("invalid app-owned image reference");
  const component = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
  const own = new RegExp(`^localhost:5000/(${app}/${component}(?:/${component})*)@sha256:[0-9a-f]{64}$`);
  const matched = own.exec(input);
  return matched?.[1] === undefined ? err("invalid app-owned image reference") : ok(Object.freeze({ reference: input, repository: matched[1] }));
};
/** Identity/provenance shape only; trusted registry inspection must establish the digest relationship. */
export const parseResolvedImage = (app: string, input: unknown) => {
  const checked = resolution.safeParse(input); if (!checked.success) return err("invalid resolved image identity");
  const source = parseOwnedImageReference(app, checked.data.source); const pull = parseOwnedImageReference(app, checked.data.pull);
  return source.ok && pull.ok && source.value.repository === pull.value.repository ? ok<ResolvedImage>(checked.data) : err("resolved image provenance is outside its app repository");
};
