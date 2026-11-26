import { strict as assert } from 'node:assert';
import { setTimeout as pause } from 'node:timers/promises';
import { summarizeRequests } from './analyze-http.mjs';
import { prematureCandidateRequests } from './http-observations.mjs';
import { request, traffic } from './http-probe.mjs';

const candidates = [
  { release: 'C', name: 'slow-readiness', previous: 'B', expected: 'C' },
  { release: 'D', name: 'never-ready', previous: 'C', expected: 'C' },
  { release: 'E', name: 'failure-after-readiness', previous: 'C', expected: 'C' },
  { release: 'F', name: 'long-request', previous: 'C', expected: 'F' },
];

export async function runCompleteHttpCases({ manifest, target, submit, terminal, readNativePlan, events, requests, setPhase, event, baseline }) {
  const results = [];
  let previousPlan = baseline.nativePlan;
  let final;
  for (const item of candidates) {
    const { release, name, expected, previous } = item;
    const interrupted = release === 'E';
    const successful = release === expected;
    const samples = [];
    setPhase(name + ':baseline');
    const stop = traffic(target, (value) => {
      const sample = { ...value, phase: name };
      samples.push(sample);
      requests.push(sample);
    });
    try {
      await pause(3000);
      let longResponse;
      if (release === 'F') {
        const { promise: headers, resolve } = Promise.withResolvers();
        longResponse = request(target, { path: '/slow?ms=20000', timeout: 35000, onHeaders: resolve });
        const started = await Promise.race([headers, longResponse]);
        assert.equal(started.status, 200);
        assert.equal(started.release, previous);
        assert.ok(started.task, 'the original task accepted the delayed request');
        event('delayed-request-accepted', started);
      }
      const submittedAt = Date.now();
      setPhase(name + ':update');
      const { receipt } = await submit(release);
      event('replacement-accepted', { name, submittedAt, receipt });
      final = await terminal(receipt, successful ? ['deployed'] : interrupted ? ['rolled-back'] : ['rolled-back', 'unchanged']);
      const convergedAt = Date.now();
      assert.equal(final.verifiedActive.commit, manifest.commits[expected]);
      const nativePlan = await readNativePlan();
      assert.equal(nativePlan === previousPlan, !successful);
      const duringUpdate = events.filter((entry) => entry.Type === 'container' &&
        !entry.Actor.Attributes['com.kayra.job'] && entry.Actor.Attributes['com.kayra.plan'] !== previousPlan &&
        entry.timeNano / 1e6 >= submittedAt && entry.timeNano / 1e6 <= convergedAt);
      const started = duringUpdate.find((entry) => entry.Action === 'start');
      assert.ok(started, 'replacement container started');
      const candidatePlan = started.Actor.Attributes['com.kayra.plan'];
      assert.match(candidatePlan, /^[a-f0-9]{64}$/);
      if (successful) assert.equal(candidatePlan, nativePlan);
      const lifecycle = duringUpdate.filter((entry) => entry.Actor.Attributes['com.kayra.plan'] === candidatePlan);
      const healthy = lifecycle.find((entry) => entry.Action === 'health_status: healthy');
      const crash = lifecycle.find((entry) => entry.Action === 'die' && entry.Actor.Attributes.exitCode === '42');
      const recoveryMs = crash === undefined ? null : convergedAt - crash.timeNano / 1e6;
      const long = longResponse === undefined ? null : { kind: 'long', phase: name, ...await longResponse };
      if (long !== null) requests.push(long);
      setPhase(name + ':stable');
      await pause(30000);
      await stop();
      const baselineSamples = samples.filter((value) => value.endedAt < submittedAt);
      const stable = samples.filter((value) => value.at >= convergedAt);
      const summary = summarizeRequests(samples);
      const premature = prematureCandidateRequests(samples, release);
      const result = { name, release, expected, nativePlan, candidatePlan, submittedAt, convergedAt,
        recoveryMs, operation: final.operation, requests: summary, long, prematureExposure: premature.length };
      event('http-case', result);
      assert.ok(baselineSamples.length >= 50 && baselineSamples.every((value) => value.status === 200 && value.release === previous && value.ready));
      assert.ok(stable.length >= 570 && stable.every((value) => value.status === 200 && value.release === expected && value.ready));
      assert.ok(summary.achievedRequestsPerSecond >= 19 && summary.maximumStartGapMs <= 250, 'observer was suspended or starved');
      assert.equal(premature.length, 0);
      if (!interrupted) assert.equal(summary.failed, 0, 'continuity case lost requests');
      if (release === 'C') {
        assert.ok(healthy && healthy.timeNano - started.timeNano >= 14e9, 'candidate remained unready during preparation');
        const preparing = samples.filter((value) => value.at >= started.timeNano / 1e6 && value.endedAt < healthy.timeNano / 1e6);
        assert.ok(preparing.length >= 200 && preparing.every((value) => value.release === previous));
      }
      if (release === 'D') {
        assert.ok(convergedAt - submittedAt <= 90000, 'never-ready attempt did not settle within 90 seconds');
        assert.ok(healthy === undefined && samples.every((value) => value.release !== release));
      }
      if (interrupted) {
        assert.ok(healthy && crash && healthy.Actor.ID === crash.Actor.ID && healthy.timeNano < crash.timeNano);
        assert.ok(recoveryMs >= 0 && recoveryMs <= 90000, 'post-readiness recovery took more than 90 seconds');
      }
      if (long !== null) {
        assert.equal(long.status, 200);
        assert.equal(long.error, undefined);
        assert.equal(long.release, previous);
        assert.ok(long.latencyMs >= 19500 && started.timeNano / 1e6 < long.endedAt, 'the original request did not overlap replacement');
      }
      results.push(result);
      previousPlan = nativePlan;
    } finally {
      await stop();
    }
  }
  return { results, final };
}
