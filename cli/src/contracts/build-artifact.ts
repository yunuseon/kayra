import type { RegistrationGeneration } from "./registration-generation.ts";

/** Trusted composition validates builder output before returning these bytes. */
export type BuildPorts = {
  readonly now: () => number;
// eslint-disable-next-line functional/prefer-immutable-types -- AbortSignal is an externally owned cancellation notification
  readonly prepare: (registration: RegistrationGeneration, commit: string, deadline: number, signal: AbortSignal) => Promise<string>;
  readonly retain: (content: string) => Promise<string>;
  readonly images: (content: string, registration: RegistrationGeneration, commit: string) => readonly string[];
  readonly read: (digest: string) => Promise<string>;
};

/** Conservative build pins; runtime-plan pins are required before GC can be enabled. */
export type BuildImagePins = {
  readonly version: 1;
  readonly complete: false;
  readonly reason: "runtime plan pins are not integrated";
  readonly artifacts: readonly {
    readonly build: string;
    readonly registration: RegistrationGeneration;
    readonly commit: string;
    readonly artifact: string;
    readonly images: readonly string[];
  }[];
  readonly unresolved: readonly { readonly build: string; readonly registration: RegistrationGeneration; readonly commit: string; readonly deadline: number }[];
};
