import { parseLifecycleEnvelope } from "./lifecycle-envelope.ts";

export const verifiedRegistration = (app: string, input: unknown) => {
  const parsed = parseLifecycleEnvelope(input);
  if (!parsed.ok) throw new Error("registration state is missing or invalid");
  const state = parsed.value;
  if (state.registrationAllocation === undefined || state.fence?.lifecycle.phase !== "registered") throw new Error("registration has not been verified");
  if (state.registrationReceipt === undefined) throw new Error("registration has no verified receipt");
  if (state.tickets.app !== app) throw new Error("invalid verified registration identity");
  return state.registrationReceipt.metadata;
};
