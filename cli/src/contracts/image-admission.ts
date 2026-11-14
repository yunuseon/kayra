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
