/** Adapter-owned inspection of immutable registry metadata; never pulls or creates workloads. */
export type ImageAdmissionPort = {
  readonly verify: (app: string, images: readonly string[]) => Promise<"accepted" | "unsupported" | "unavailable">;
};
