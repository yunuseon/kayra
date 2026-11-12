import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function summarizeRequests(records) {
  const ordered = [...records].sort((a, b) => a.at - b.at);
  const failed = ordered.filter((value) => value.error !== undefined || value.status !== 200);
  let start; let longest = 0;
  for (const value of ordered) {
    if (value.error !== undefined || value.status !== 200) { start ??= value.at; longest = Math.max(longest, value.at - start); }
    else start = undefined;
  }
  const duration = ordered.length < 2 ? 0 : ordered.at(-1).at - ordered[0].at;
  return { count: records.length, failed: failed.length, achievedRequestsPerSecond: duration === 0 ? 0 : (records.length - 1) * 1000 / duration,
    maximumStartGapMs: Math.max(0, ...records.map((value) => value.gapMs ?? 0)),
    longestSampledFailureIntervalMs: longest,
    firstFailedStartToLastFailedCompletionMs: failed.length === 0 ? 0 : Math.max(...failed.map((value) => value.endedAt)) - Math.min(...failed.map((value) => value.at)),
    connections: Object.fromEntries(['fresh', 'persistent'].map((connection) => {
      const selected = records.filter((value) => value.connection === connection);
      const failures = selected.filter((value) => value.error !== undefined || value.status !== 200);
      return [connection, { count: selected.length, failed: failures.length, causes: Object.fromEntries([...new Set(failures.map((value) => value.error ?? 'HTTP ' + value.status))].map((cause) => [cause, failures.filter((value) => (value.error ?? 'HTTP ' + value.status) === cause).length])) }];
    })) };
}

export function resourcePeaks(records) {
  return { samples: records.length,
    peakUsedBytes: records.length === 0 ? null : Math.max(...records.map((value) => value.memoryTotalBytes - value.memoryAvailableBytes)),
    minimumAvailableBytes: records.length === 0 ? null : Math.min(...records.map((value) => value.memoryAvailableBytes)),
    peakCpuBusyFraction: records.length === 0 ? null : Math.max(...records.map((value) => value.cpuBusyFraction ?? 0)) };
}

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const jsonl = async (path) => (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
export async function analyze(directory) {
  const manifest = await json(join(directory, 'manifest.json'));
  const summary = await json(join(directory, 'summary.json')).catch(() => ({ complete: false, results: [] }));
  const baseline = await jsonl(join(directory, 'baseline-requests.jsonl'));
  const observations = await jsonl(join(directory, 'observer.jsonl'));
  const docker = await jsonl(join(directory, 'docker-events.jsonl'));
  const vm = await jsonl(join(directory, 'vm.jsonl'));
  const base = summarizeRequests(baseline);
  const baselinePassed = base.count >= 570 && base.failed === 0 && base.achievedRequestsPerSecond >= 19 && base.maximumStartGapMs < 2000 && baseline.every((value) => value.release === 'A' && value.ready === true);
  const cases = [];
  for (const item of summary.results) {
    const records = await jsonl(join(directory, `${item.name}-${item.repeat}-requests.jsonl`));
    const requests = summarizeRequests(records);
    const accepted = observations.find((value) => value.kind === 'update-accepted' && value.case?.name === item.name && value.case?.repeat === item.repeat)?.accepted;
    const candidate = docker.filter((event) => event.Actor?.Attributes?.['com.kayra.plan'] === accepted?.plan);
    const crashes = candidate.filter((event) => event.Action === 'die' && event.Actor?.Attributes?.exitCode === '42');
    const healthyBeforeCrash = crashes.some((crash) => candidate.some((event) => event.Action === 'health_status: healthy' && event.Actor.ID === crash.Actor.ID && event.timeNano < crash.timeNano));
    const premature = records.filter((value) => value.release === item.release && (value.ready !== true || (value.readyAt !== null && value.requestStartedAt < value.readyAt)));
    const forbiddenCandidate = item.name === 'never-ready' ? records.filter((value) => value.release === item.release).length : 0;
    const expected = ['never-ready', 'crash-after-ready'].includes(item.name) ? 'A' : item.release;
    const stable = records.filter((value) => value.at >= item.convergedAt);
    const stablePassed = stable.length >= 570 && stable.every((value) => value.status === 200 && value.error === undefined && value.release === expected);
    const passed = item.passed && requests.failed === item.failedRequests && premature.length === 0 && forbiddenCandidate === 0 &&
      requests.achievedRequestsPerSecond >= 19 && requests.maximumStartGapMs < 2000 && stablePassed &&
      (item.name !== 'crash-after-ready' || healthyBeforeCrash);
    cases.push({ ...item, passed, requests, healthyBeforeCrash, prematureExposure: premature.length, forbiddenCandidate, stablePassed });
  }
  const live = new Set(); const changes = [];
  for (const event of [...docker].sort((a, b) => a.timeNano - b.timeNano)) {
    if (event.Type !== 'container') continue;
    if (event.Action === 'start') live.add(event.Actor.ID);
    if (event.Action === 'die' || event.Action === 'destroy') live.delete(event.Actor.ID);
    changes.push({ at: event.timeNano / 1_000_000, count: live.size });
  }
  const overlapping = vm.filter((sample) => sample.case !== null && sample.phase !== 'reset' && [...changes].reverse().find((event) => event.at <= sample.at)?.count >= 2);
  const failedWindow = vm.filter((sample) => cases.some((item) => item.failureStartsAt !== null && sample.at >= item.failureStartsAt && sample.at <= item.failureEndsAt));
  const recovering = vm.filter((sample) => cases.some((item) => {
    const accepted = observations.find((value) => value.kind === 'update-accepted' && value.case?.name === item.name && value.case?.repeat === item.repeat)?.accepted;
    const firstDeath = docker.find((event) => event.Action === 'die' && event.Actor?.Attributes?.['com.kayra.plan'] === accepted?.plan);
    return firstDeath !== undefined && sample.at >= firstDeath.timeNano / 1_000_000 && sample.at <= item.convergedAt;
  }));
  const report = { complete: summary.complete === true && cases.length === manifest.matrix.length,
    passed: summary.complete === true && cases.length === manifest.matrix.length && baselinePassed && cases.every((item) => item.passed),
    baseline: { ...base, passed: baselinePassed }, cases,
    resources: { baseline: resourcePeaks(vm.filter((value) => value.phase === 'baseline')), overlap: resourcePeaks(overlapping),
      sampledFailureWindow: resourcePeaks(failedWindow), recovery: resourcePeaks(recovering), overall: resourcePeaks(vm) },
    limits: ['Sampled failure intervals are not exact continuous outages.', 'The observer and TLS/platform overhead are included in VM measurements.', 'Single node; migration, worker, singleton, retention and exhaustion checks are separate.'] };
  await writeFile(join(directory, 'analysis.json'), JSON.stringify(report, null, 2) + '\n');
  const rows = cases.map((item) => `| ${item.name} | ${item.repeat} | ${item.passed ? 'pass' : 'FAIL'} | ${item.requests.failed} | ${(item.elapsedMs / 1000).toFixed(2)} | ${(item.requests.longestSampledFailureIntervalMs / 1000).toFixed(2)} |`);
  await writeFile(join(directory, 'REPORT.md'), `# Real-deployer HTTP continuity\n\n${report.complete ? 'Complete' : 'Incomplete'} matrix: ${cases.filter((item) => item.passed).length}/${manifest.matrix.length} passed. Baseline: ${base.count} requests, ${base.failed} failed, ${base.achievedRequestsPerSecond.toFixed(2)} requests/s.\n\n| Case | Repeat | Result | Failed requests | Recovery/convergence s | Longest sampled failure interval s |\n|---|---:|---|---:|---:|---:|\n${rows.join('\n')}\n\nPost-readiness failures are disruptive automatic recovery. Failure intervals are sampled, not universal downtime bounds. See per-request JSONL, native events, access logs, VM samples and analysis.json.\n`);
  return report;
}
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await analyze(process.argv[2]);
  console.log(JSON.stringify({ complete: report.complete, passed: report.passed, cases: report.cases.length, baseline: report.baseline }));
  if (!report.passed) process.exitCode = 1;
}
