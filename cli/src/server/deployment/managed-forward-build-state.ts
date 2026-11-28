import type { RegistrationGeneration } from "../../contracts/registration-generation.ts";
import { parseLifecycleAppIndex, lifecycleIndexPreparedForwardBuild } from "./lifecycle-app-index-state.ts";

/** Pure receipt publication. Authority and artifact validation belong to the owning command before this synchronized index replacement. */
export const preparedManagedForwardBuild = (input: unknown, expected: { readonly app: string; readonly request: string; readonly selection: string; readonly registration: RegistrationGeneration; readonly commit: string }, receipt: unknown) => {
  const state = parseLifecycleAppIndex(input); const build = lifecycleIndexPreparedForwardBuild.parse(receipt);
  const owner = state.apps.find((item) => item.app === expected.app); const decision = owner?.forwardSelections?.find((item) => item.request === expected.request);
  const record = state.builds.find((item) => item.id === build.id);
  if (owner?.protocol !== "managed-v3" || owner.phase !== "ready" || decision?.phase !== "ready" || decision.decision !== expected.selection || JSON.stringify(decision.registration) !== JSON.stringify(expected.registration) ||
    record?.artifact !== build.artifact || record.deadline !== build.deadline || record.commit !== expected.commit || JSON.stringify(record.registration) !== JSON.stringify(expected.registration)) throw new Error("managed forward build publication lacks its exact decision and retained artifact");
  if (decision.preparedBuild !== undefined) {
    if (JSON.stringify(decision.preparedBuild) !== JSON.stringify(build)) throw new Error("managed forward build receipt conflicts"); return state;
  }
  return parseLifecycleAppIndex({ ...state, apps: state.apps.map((item) => item.app === expected.app ? Object.freeze({ ...item, forwardSelections: Object.freeze((item.forwardSelections ?? []).map((selection) => selection.request === expected.request ? Object.freeze({ ...selection, preparedBuild: build }) : selection)) }) : item) });
};
