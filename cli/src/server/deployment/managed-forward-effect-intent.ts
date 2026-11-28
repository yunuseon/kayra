import { createHash } from "node:crypto";
import { managedForwardEffectSource, managedForwardEffectNodes } from "./managed-forward-effect-source.ts";
import { parseManagedForwardEffects } from "./managed-forward-effect-state.ts";

/** Shared initialization intent. Retention and journal synchronization precede publication; no runtime ports are available here. */
export const managedForwardEffectIntent = (input: unknown) => {
  const source = managedForwardEffectSource(input); const bytes = JSON.stringify(source); const owner = source.baseline.state.owner;
  const state = parseManagedForwardEffects({ version: 1, source: createHash("sha256").update(bytes).digest("hex"), run: source.request.run, action: source.request.action, app: owner.app, incarnation: owner.incarnation, dataOwner: owner.dataOwner, createdAt: source.request.createdAt, deadline: source.deadline,
    phase: "fencing", reason: null, finishedAt: null, cursor: 0, nodes: managedForwardEffectNodes(source).map(({ name, plan, prior, waitFor, checks }) => Object.freeze({ name, plan, prior, waitFor, checks, barrier: null, proofs: Object.freeze([]) })),
  });
  return Object.freeze({ source, bytes, state });
};
