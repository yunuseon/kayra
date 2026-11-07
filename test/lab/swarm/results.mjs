const good = (request) => !request.error && request.status === 200 && typeof request.body?.release === 'string';
const percentile = (values, fraction) => values.length === 0 ? null : values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];

export function trafficEvidence(records) {
  const samples = records.filter((row) => row.kind === 'short').toSorted((a, b) => a.at - b.at);
  const gaps = samples.slice(1).map((row, index) => row.at - samples[index].at);
  const maxGapMs = Math.max(0, ...gaps);
  const durationMs = samples.length > 1 ? samples.at(-1).at - samples[0].at : 0;
  const requestsPerSecond = durationMs > 0 ? (samples.length - 1) * 1000 / durationMs : 0;
  return { passed: maxGapMs <= 1000 && requestsPerSecond >= 18, maxGapMs, requestsPerSecond };
}

export function settlement(records, outcome, expectedRelease) {
  const samples = records.filter((row) => row.kind === 'short');
  const wrong = samples.filter((row) => !good(row) || row.body.release !== expectedRelease);
  const after = Math.max(outcome.observedAt, ...wrong.map((row) => row.endedAt));
  const tail = samples.filter((row) => row.at >= after).toSorted((a, b) => a.at - b.at);
  const recoveredAt = tail[0]?.at ?? null;
  const observedForMs = tail.length ? tail.at(-1).at - recoveredAt : 0;
  return { recoveredAt, observedForMs, stable: tail.length >= 500 && observedForMs >= 30000 };
}

export function assess({ scenario, records, outcome, updateAt, longRequest, observer, deadlineMs = 90000 }) {
  const shorts = records.filter((record) => record.kind === 'short');
  const failures = shorts.filter((record) => !good(record));
  const premature = shorts.filter((record) => good(record) && (record.body.readyAt === null || record.body.requestStartedAt < record.body.readyAt));
  const candidate = shorts.filter((record) => good(record) && record.body.release === 'B');
  const oldAfter = shorts.filter((record) => good(record) && record.body.release === 'A' && record.at >= updateAt);
  const rollback = scenario === 'never-ready' || scenario === 'crash-after-ready';
  const expectedState = rollback ? 'rollback_completed' : 'completed';
  const expectedRelease = rollback ? 'A' : 'B';
  const settled = settlement(records, outcome, expectedRelease);
  const convergenceMs = settled.recoveredAt === null ? null : settled.recoveredAt - updateAt;
  const converged = outcome.state === expectedState && outcome.observedAt - updateAt <= deadlineMs && convergenceMs !== null && convergenceMs <= deadlineMs;
  const stableTail = settled.stable;
  const traffic = trafficEvidence(records);
  const reasons = [];
  if (!traffic.passed) reasons.push('load generator did not sustain the required traffic; measurement is invalid');
  if (!converged) reasons.push(`expected ${expectedState} and HTTP recovery within ${deadlineMs / 1000}s; observed ${outcome.state}`);
  if (premature.length) reasons.push(`${premature.length} application requests reached an unready task`);
  if (scenario !== 'crash-after-ready' && failures.length) reasons.push(`${failures.length} failed short requests`);
  if (scenario === 'never-ready' && candidate.length) reasons.push(`${candidate.length} requests reached the permanently unready candidate`);
  if (!rollback && candidate.length === 0) reasons.push('no successful request reached release B');
  if (!stableTail) reasons.push('the 30-second post-convergence window was not consistently served by the expected release');
  if (scenario === 'long-request' && (!good(longRequest ?? {}) || longRequest.body?.release !== 'A')) reasons.push('the original long request did not complete on A');
  if (scenario === 'observer-interruption' && !observer?.reconstructed) reasons.push('observer restart did not reconstruct service state');
  const sorted = shorts.toSorted((a, b) => a.at - b.at);
  let failureStart = null;
  let longestGapMs = 0;
  for (const sample of sorted) {
    if (!good(sample)) failureStart ??= sample.at;
    else if (failureStart !== null) { longestGapMs = Math.max(longestGapMs, sample.at - failureStart); failureStart = null; }
  }
  if (failureStart !== null) longestGapMs = Math.max(longestGapMs, sorted.at(-1).endedAt - failureStart);
  return {
    passed: reasons.length === 0, reasons, scenario, traffic, requests: shorts.length,
    failedRequests: failures.length, prematureRequests: premature.length,
    candidateRequests: candidate.length, oldRequestsAfterUpdate: oldAfter.length,
    convergenceMs, nativeConvergenceMs: outcome.observedAt - updateAt, trafficRecoveryAt: settled.recoveredAt, stableObservationMs: settled.observedForMs, outcome,
    longestObservedFailureIntervalMs: longestGapMs,
    firstFailureAt: failures[0]?.at ?? null, lastFailureAt: failures.at(-1)?.at ?? null,
    latencyMs: { p50: percentile(shorts.map((row) => row.latencyMs), 0.5), p99: percentile(shorts.map((row) => row.latencyMs), 0.99), max: Math.max(0, ...shorts.map((row) => row.latencyMs)) },
    longRequest, observer,
  };
}

export function verdict(results, expectedRepeats = 3) {
  const scenarios = ['healthy', 'slow-ready', 'never-ready', 'crash-after-ready', 'long-request', 'observer-interruption'];
  const modes = ['tasks', 'vip'].map((mode) => {
    const selected = results.filter((result) => result.mode === mode);
    const complete = scenarios.every((scenario) => Array.from({ length: expectedRepeats }, (_, i) => i + 1)
      .every((repeat) => selected.some((row) => row.scenario === scenario && row.repeat === repeat)));
    return { mode, complete, passed: complete && selected.every((row) => row.passed), results: selected.length };
  });
  return { modes, viable: modes.some((mode) => mode.passed), complete: modes.every((mode) => mode.complete) };
}
