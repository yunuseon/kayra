import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { prematureCandidateRequests } from './http-observations.mjs';

test('candidate readiness does not mistake successful previous-release draining for premature candidate exposure', () => {
  const draining = { release: 'A', ready: false, status: 200 };
  const premature = { release: 'B', ready: false, status: 200 };
  const ready = { release: 'B', ready: true, status: 200 };
  assert.deepEqual(prematureCandidateRequests([draining, premature, ready], 'B'), [premature]);
  assert.deepEqual(prematureCandidateRequests([draining, ready], 'B'), []);
});
