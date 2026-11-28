import type { ResourceCharge } from "./resource-book.ts";

type Budget = { readonly cpu: number; readonly memory: number };

/** Start-first recovery can overlap draining A, candidate B and restored A. */
export const httpRecoveryPeak = (target: Budget, previous: Budget | null) => Object.freeze({
  cpu: target.cpu + 2 * (previous?.cpu ?? 0), memory: target.memory + 2 * (previous?.memory ?? 0),
});

export const hasHttpRecoveryPeak = (charge: ResourceCharge) => {
  const minimum = httpRecoveryPeak(charge.target.budget, charge.previous?.budget ?? null);
  return charge.peak.cpu >= minimum.cpu && charge.peak.memory >= minimum.memory;
};
