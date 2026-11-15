import { z } from "zod";
import { parseManagedServicePlan } from "./managed-service-plan.ts";
import { volumeReceiptSchema } from "./owned-volume.ts";
import { err, ok } from "../lib/result.ts";

const receiptsSchema = z.array(volumeReceiptSchema).max(32).readonly();
/** Compare execution evidence to immutable allocation identities. This is not a fresh native observation or admission grant. */
const matchManagedVolumeReceipts = (input: unknown, evidence: unknown) => {
  const plan = parseManagedServicePlan(input); const receipts = receiptsSchema.safeParse(evidence);
  if (!plan.ok || !receipts.success) return err("managed volume evidence is invalid");
  const expected = new Set(plan.value.mounts.map((mount) => mount.volume.allocation));
  if (receipts.data.length !== expected.size || new Set(receipts.data.map((receipt) => receipt.volume.allocation)).size !== receipts.data.length ||
    receipts.data.some((receipt) => !expected.has(receipt.volume.allocation))) return err("managed volume evidence does not match the plan");
  const mounts = plan.value.mounts.map((mount) => {
    const receipt = receipts.data.find((item) => item.volume.allocation === mount.volume.allocation);
    return receipt !== undefined && JSON.stringify(receipt.volume) === JSON.stringify(mount.volume) ? Object.freeze({ ...mount, createdAt: receipt.createdAt }) : undefined;
  });
  if (mounts.some((mount) => mount === undefined)) return err("managed volume ownership evidence disagrees");
  return ok(Object.freeze(mounts.filter((mount) => mount !== undefined)));
};

const observationsSchema = z.array(z.object({ status: z.literal("owned"), receipt: volumeReceiptSchema }).strict().readonly()).max(32).readonly();
/** Compare recorded creation evidence with normalized observations. The caller still owns freshness, lifecycle fencing and admission. */
export const matchManagedVolumeEvidence = (input: unknown, recorded: unknown, observed: unknown) => {
  const mounts = matchManagedVolumeReceipts(input, recorded); const receipts = receiptsSchema.safeParse(recorded); const observations = observationsSchema.safeParse(observed);
  if (!mounts.ok || !receipts.success || !observations.success) return err("managed volume evidence is unavailable or invalid");
  if (observations.data.length !== receipts.data.length || new Set(observations.data.map((item) => item.receipt.volume.allocation)).size !== observations.data.length ||
    receipts.data.some((receipt) => !observations.data.some((item) => JSON.stringify(item.receipt) === JSON.stringify(receipt)))) return err("managed volume creation evidence changed");
  return mounts;
};
