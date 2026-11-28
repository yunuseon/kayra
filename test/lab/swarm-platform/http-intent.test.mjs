import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseApplicationPlan } from '../../../cli/src/contracts/application-plan.ts';
import { parseRolloutPlan, rolloutPlanDigest, rolloutWorkloadDigest } from '../../../cli/src/contracts/rollout-plan.ts';
import { nativeHttpIntent } from './http-intent.mjs';

const checked = parseApplicationPlan(JSON.parse(readFileSync(new URL('../../../ci/tests/swarm-http/native-plan.json', import.meta.url), 'utf8'))); assert.ok(checked.ok);
const workload = checked.value; const native = createHash('sha256').update(JSON.stringify(workload)).digest('hex');
const full = parseRolloutPlan({ version: 2, runtime: 'swarm', workload, rollout: workload.rollout,
  policy: { version: 1, migrationTimeoutCeilingSeconds: 90, schedulingSeconds: 90, cleanupSeconds: 30, maximumAttempts: 8 } }); assert.ok(full.ok);
const receipt = { app: workload.app, commit: workload.commit, request: '11111111-1111-4111-8111-111111111111', deadline: 10000, phase: 'prepared', cancelRequestedAt: null };

test('HTTP observations use the workload digest while preserving the distinct complete deployment identity', () => {
  const accepted = { ...receipt, version: 2, plan: rolloutPlanDigest(full.value) };
  assert.equal(nativeHttpIntent(accepted, { admitted: false, plan: full.value }), rolloutWorkloadDigest(full.value));
  assert.notEqual(nativeHttpIntent(accepted, { admitted: false, plan: full.value }), accepted.plan);
});

test('legacy receipt observations retain their original HTTP plan identity', () => {
  assert.equal(nativeHttpIntent({ ...receipt, version: 1, plan: native }, { admitted: false, plan: workload }), native);
});

test('a changed preview or mismatched receipt cannot establish native acknowledgement', () => {
  const accepted = { ...receipt, version: 2, plan: rolloutPlanDigest(full.value) };
  for (const preview of [{ admitted: true, plan: full.value }, { admitted: false, plan: workload }, { admitted: false, plan: { ...full.value, policy: { ...full.value.policy, migrationTimeoutCeilingSeconds: 120 } } }]) assert.throws(() => nativeHttpIntent(accepted, preview));
  for (const value of [{ ...accepted, commit: 'f'.repeat(40) }, { ...accepted, plan: native }, { ...accepted, version: 3 }, { ...accepted, deadline: -1 }]) assert.throws(() => nativeHttpIntent(value, { admitted: false, plan: full.value }));
});
