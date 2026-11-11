import { parseRegistrationGeneration } from "../../contracts/registration-generation.ts";
import { parseLifecycleEnvelope } from "./lifecycle-envelope.ts";
import { admitTicket } from "./lifecycle-tickets.ts";
import { lifecycleActionId } from "./lifecycle-fence.ts";

export const verifiedRegistration = (app: string, input: unknown) => {
  const parsed = parseLifecycleEnvelope(input);
  if (!parsed.ok) throw new Error("registration state is missing or invalid");
  const state = parsed.value;
  const allocation = state.registrationAllocation;
  const fence = state.fence;
  if (allocation === undefined || fence?.lifecycle.phase !== "registered") throw new Error("registration has not been verified");
  const receipt = admitTicket(state.tickets, allocation.ticket, { kind: "register", registrationGeneration: allocation.generation });
  if (!receipt.ok || receipt.value.status !== "terminal" || receipt.value.outcome !== "success") throw new Error("registration has no verified receipt");
  const metadata = parseRegistrationGeneration({
    version: 1, app, incarnation: state.tickets.incarnation,
    actionId: lifecycleActionId(fence, 1), registrationGeneration: allocation.generation,
  });
  if (!metadata.ok || state.tickets.app !== app) throw new Error("invalid verified registration identity");
  return metadata.value;
};
