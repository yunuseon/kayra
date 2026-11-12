import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { resourcePeaks, summarizeRequests } from './analyze-http.mjs';

test('failure summaries distinguish a sampled run of failures from in-flight timeout duration', () => {
  const request = (at, fields = {}) => ({ at, endedAt: at + 10, status: 200, connection: 'fresh', gapMs: 50, ...fields });
  const summary = summarizeRequests([request(150, { error: 'timeout', endedAt: 2150, connection: 'persistent' }), request(0), request(50, { status: 502 }), request(100, { status: 502 }), request(200)]);
  assert.equal(summary.count, 5); assert.equal(summary.failed, 3);
  assert.equal(summary.longestSampledFailureIntervalMs, 100);
  assert.equal(summary.firstFailedStartToLastFailedCompletionMs, 2100);
  assert.equal(summary.achievedRequestsPerSecond, 20);
  assert.equal(summary.connections.fresh.failed, 2); assert.equal(summary.connections.persistent.causes.timeout, 1);
});

test('resource peaks retain available-memory and aggregate CPU evidence without inventing empty phases', () => {
  assert.deepEqual(resourcePeaks([]), { samples: 0, peakUsedBytes: null, minimumAvailableBytes: null, peakCpuBusyFraction: null });
  assert.deepEqual(resourcePeaks([{ memoryTotalBytes: 400, memoryAvailableBytes: 300, cpuBusyFraction: null }, { memoryTotalBytes: 400, memoryAvailableBytes: 200, cpuBusyFraction: 0.25 }]),
    { samples: 2, peakUsedBytes: 200, minimumAvailableBytes: 200, peakCpuBusyFraction: 0.25 });
});
