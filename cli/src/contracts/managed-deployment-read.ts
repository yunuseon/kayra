import type { ManagedWorkloadPort } from "./managed-workloads.ts";

/** Reporting capabilities contain no workload effects, admission, authorization or artifact writes. */
export type ManagedDeploymentReadPort = {
  readonly now: () => number;
  readonly read: (digest: string) => Promise<string>;
};
export type ManagedHealthReadPort = ManagedDeploymentReadPort & {
  readonly services: Readonly<Pick<ManagedWorkloadPort, "observe" | "observeDesired">>;
};
