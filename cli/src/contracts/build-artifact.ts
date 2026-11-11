import type { RegistrationGeneration } from "./registration-generation.ts";

/** Trusted composition validates builder output before returning these bytes. */
export type BuildPorts = {
  readonly now: () => number;
// eslint-disable-next-line functional/prefer-immutable-types -- AbortSignal is an externally owned cancellation notification
  readonly prepare: (registration: RegistrationGeneration, commit: string, deadline: number, signal: AbortSignal) => Promise<string>;
  readonly retain: (content: string) => Promise<string>;
  readonly read: (digest: string) => Promise<string>;
};
