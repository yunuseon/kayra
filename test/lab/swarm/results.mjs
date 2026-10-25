const good = (request) => !request.error && request.status === 200 && typeof request.body?.release === 'string';
const percentile = (values, fraction) => values.length === 0 ? null : values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];

export function assess({ scenario, records, outcome, updateAt, longRequest, observer, deadlineMs = 90000 }) {
  const shorts = records.filter((record) => record.kind === 'short');
  const failures = shorts.filter((record) => !good(record));
  const premature = shorts.filter((record) => good(record) && (record.body.readyAt === null || record.body.requestStartedAt < record.body.readyAt));
  const candidate = shorts.filter((record) => good(record) && record.body.release === 'B');
  const oldAfter = shorts.filter((record) => good(record) && record.body.release === 'A' && record.at >= updateAt);
  const rollback = scenario === 'never-ready' || scenario === 'crash-after-ready';
  const expectedState = rollback ? 'rollback_completed' : 'completed';
  const converged = outcome.state === expectedState && outcome.observedAt - updateAt <= deadlineMs;
  const lastSamples = shorts.filter((record) => record.at >= outcome.observedAt);
  const expectedRelease = rollback ? 'A' : 'B';
  const stableTail = lastSamples.length >= 500 && lastSamples.every((record) => good(record) && record.body.release === expectedRelease);
  const reasons = [];
  if (!converged) reasons.push(`expected ${expectedState} within ${deadlineMs / 1000}s; observed ${outcome.state}`);
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
    passed: reasons.length === 0, reasons, scenario, requests: shorts.length,
    failedRequests: failures.length, prematureRequests: premature.length,
    candidateRequests: candidate.length, oldRequestsAfterUpdate: oldAfter.length,
    convergenceMs: outcome.observedAt - updateAt, outcome,
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
