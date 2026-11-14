import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { parseDeploymentReceipt, parseCompleteDeploymentReceipt } from '../../../cli/src/contracts/deployment-request.ts';
import { parseApplicationPlan } from '../../../cli/src/contracts/application-plan.ts';
import { parseRolloutPlan, rolloutPlanDigest, rolloutWorkloadDigest } from '../../../cli/src/contracts/rollout-plan.ts';

// Public deployment identity and native HTTP projection identity are deliberately distinct.
export const nativeHttpIntent = (receipt, preview) => {
  assert.equal(preview.admitted, false);
  assert.ok(receipt.version === 1 || receipt.version === 2);
  const accepted = receipt.version === 2 ? parseCompleteDeploymentReceipt(receipt) : parseDeploymentReceipt(receipt); assert.ok(accepted.ok, accepted.error);
  const parsed = receipt.version === 2 ? parseRolloutPlan(preview.plan) : parseApplicationPlan(preview.plan); assert.ok(parsed.ok, parsed.error);
  const workload = receipt.version === 2 ? parsed.value.workload : parsed.value;
  assert.equal(workload.app, receipt.app); assert.equal(workload.commit, receipt.commit);
  const digest = receipt.version === 2 ? rolloutPlanDigest(parsed.value) : createHash('sha256').update(JSON.stringify(workload)).digest('hex');
  assert.equal(digest, receipt.plan, 'preview must still match the accepted immutable intent');
  return receipt.version === 2 ? rolloutWorkloadDigest(parsed.value) : receipt.plan;
};
