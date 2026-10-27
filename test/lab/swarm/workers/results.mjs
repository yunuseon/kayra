import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const workerScenarios = ['graceful-drain', 'killed-worker', 'effect-idempotent', 'effect-without-idempotency', 'singleton-locked', 'singleton-unlocked'];
const time = (value) => Date.parse(value);
export function baselineEvidence(ticks) {
  const times = ticks.map((row) => Date.parse(row.at));
  const maxGapMs = times.reduce((max, at, index) => index ? Math.max(max, at - times[index-1]) : max, 0);
  const durationMs = times.at(-1) - times[0];
  return { passed: times.length >= 300 && durationMs >= 30000 && maxGapMs <= 1000, samples: times.length, durationMs, maxGapMs };
}
export function assessWorker(evidence) {
  const { scenario, repeat, database: db, initial, timeline, before, after } = evidence;
  const reasons = [];
  const require = (condition, reason) => { if (!condition) reasons.push(reason); };
  require(before.Spec.Mode.Replicated.Replicas === 1 && before.Spec.UpdateConfig.Order === 'start-first', 'one-replica start-first configuration absent');
  require(before.Spec.TaskTemplate.ContainerSpec.StopGracePeriod === 30000000000, '30-second grace absent');
  const history = db.history;
  const event = (kind, release) => history.filter((row) => row.kind === kind && (!release || row.release === release));
  const singleton = scenario.startsWith('singleton');
  let overlapMs = 0;
  for (let a = 0; a < db.ownership.length; a++) for (let b = a + 1; b < db.ownership.length; b++) {
    const left = db.ownership[a], right = db.ownership[b];
    overlapMs += Math.max(0, Math.min(time(left.ended_at), time(right.ended_at)) - Math.max(time(left.started_at), time(right.started_at)));
  }
  const triggerAt = timeline.find((row) => row.kind === 'kill-acknowledged' || row.kind === 'update-acknowledged')?.at;
  const completeAt = timeline.find((row) => row.kind === 'work-completed')?.at;
  const recoveryMs = completeAt - triggerAt;
  require(Number.isFinite(recoveryMs) && recoveryMs < 90000, 'work did not complete within 90 seconds');
  if (singleton) {
    require(db.ownership.length === 2 && db.ownership.every((row) => row.ended_at), 'two completed ownership intervals absent');
    require(event('acquired', 'A').length === 1 && event('acquired', 'B').length === 1, 'A/B ownership handoff absent');
    require(db.ticks.every((tick) => db.ownership.some((owner) => owner.task === tick.task && time(tick.at) >= time(owner.started_at) && time(tick.at) <= time(owner.ended_at))), 'work ticks outside owned intervals');
    require(db.ticks.some((row) => row.release === 'A') && db.ticks.some((row) => row.release === 'B'), 'both owners must perform work');
    if (scenario === 'singleton-locked') {
      require(overlapMs === 0, 'locked owners overlapped');
      require(event('standby', 'B').length > 0, 'B did not witness contended lock');
      const aEnd = time(db.ownership.find((row) => row.release === 'A')?.ended_at);
      const bStart = time(event('started', 'B')[0]?.at);
      require(bStart < aEnd, 'running process overlap absent');
    } else {
      require(overlapMs > 1000, 'negative control did not demonstrate concurrent ownership');
      const a = db.ownership.find((row) => row.release === 'A');
      const b = db.ownership.find((row) => row.release === 'B');
      const inside = (row) => time(row.at) >= Math.max(time(a?.started_at), time(b?.started_at)) && time(row.at) < Math.min(time(a?.ended_at), time(b?.ended_at));
      require(db.ticks.some((row) => row.release === 'A' && inside(row)) && db.ticks.some((row) => row.release === 'B' && inside(row)), 'no work from both owners during overlap');
    }
  } else {
    require(db.jobs.length === 20 && db.jobs.every((row) => row.state === 'done'), 'jobs missing or unacknowledged');
    const effects = scenario === 'effect-without-idempotency' ? db.raw_effects : db.effects;
    const ids = new Set(effects.map((row) => row.job_id));
    require(ids.size === 20 && db.jobs.every((job) => ids.has(job.id)), 'durable effects missing');
    const target = db.jobs.find((row) => row.id === 0);
    require(event('acknowledged').length === 20 && db.jobs.every((job) => event('acknowledged').filter((row) => row.job_id === job.id).length === 1), 'one acknowledgement per completed job absent');
    require(db.jobs.every((job) => effects.filter((row) => row.job_id === job.id).length === (scenario === 'effect-without-idempotency' && job.id === 0 ? 2 : 1)), 'wrong per-job effect multiplicity');
    if (scenario === 'graceful-drain') {
      require(db.jobs.every((row) => row.attempts === 1) && effects.length === 20, 'draining caused duplicate attempts/effects');
      const ack = event('acknowledged', 'A').find((row) => row.job_id === 0);
      require(time(ack?.at) > time(event('started', 'B')[0]?.at) && ack?.task === initial.task, 'long A job did not finish during B overlap');
      require(event('drained', 'A').length === 1, 'A did not drain gracefully');
    } else {
      require(target?.attempts === 2 && target?.owner !== initial.task && evidence.killed?.startsWith(initial.task), 'exact worker kill and redelivery absent');
      const claims = event('claimed').filter((row) => row.job_id === 0);
      require(claims.length === 2 && claims[0].task === initial.task && claims[1].task !== initial.task, 'two different task deliveries absent');
      if (scenario.startsWith('effect-')) require(event('effect-committed').filter((row) => row.job_id === 0).length === 2 && event('before-ack-paused').length === 1, 'crash window after committed effect not proven');
      require(effects.length === (scenario === 'effect-without-idempotency' ? 21 : 20), 'unexpected durable effect count');
    }
  }
  if (!evidence.killed) require(after.UpdateStatus?.State === 'completed', 'native update did not complete');
  return { scenario, repeat, passed: reasons.length === 0, reasons, jobs: db.jobs.length, attempts: db.jobs.reduce((sum, row) => sum + row.attempts, 0), effects: db.effects.length + db.raw_effects.length, overlapMs, recoveryMs, nativeOutcome: after.UpdateStatus?.State ?? 'replacement', negativeControl: ['effect-without-idempotency', 'singleton-unlocked'].includes(scenario) };
}
export function workerVerdict(results) {
  const complete = workerScenarios.every((scenario) => [1,2,3].every((repeat) => results.some((row) => row.scenario === scenario && row.repeat === repeat)));
  return { complete, passed: results.length > 0 && results.every((row) => row.passed), cases: results.length, passedCases: results.filter((row) => row.passed).length };
}
const ndjson = (path) => readFileSync(path, 'utf8').split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
export function analyzeWorkers(output) {
  const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'));
  const events = summary.results.length ? ndjson(join(output, 'docker-events.ndjson')) : [];
  const results = summary.results.map((previous) => {
    const path = join(output, `${previous.scenario}-${previous.repeat}`);
    const evidence = JSON.parse(readFileSync(join(path, 'evidence.json'), 'utf8'));
    const result = assessWorker(evidence);
    if (evidence.killed) {
      const die = events.find((row) => row.Action === 'die' && row.Actor?.ID === evidence.killed && row.Actor.Attributes?.exitCode === '137');
      if (!die) result.reasons.push('Docker exit 137 fault evidence absent');
    } else if (previous.scenario === 'graceful-drain') {
      const containers = readdirSync(path).filter((name) => /^container-.*\.json$/.test(name)).flatMap((name) => JSON.parse(readFileSync(join(path, name), 'utf8')));
      if (!containers.some((row) => row.Id.startsWith(evidence.initial.task) && row.State.ExitCode === 0 && row.State.Status === 'exited')) result.reasons.push('gracefully exited A container absent');
    }
    result.passed = result.reasons.length === 0;
    writeFileSync(join(path, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  });
  const baseline = summary.results.length ? baselineEvidence(JSON.parse(readFileSync(join(output, 'baseline/ticks.json'), 'utf8'))) : null;
  if (baseline && !baseline.passed) summary.infrastructureError ??= 'baseline replay rejected interrupted work';
  const metrics = summary.results.length ? ndjson(join(output, 'metrics.ndjson')).filter((row) => row.kind === 'vm') : [];
  const maxTelemetryGapMs = metrics.reduce((max, row, index) => index ? Math.max(max, row.at - metrics[index-1].at) : max, 0);
  if (summary.results.length && (metrics.length < 2 || maxTelemetryGapMs > 15000)) summary.infrastructureError ??= 'VM telemetry gap invalidates timing evidence';
  const verdict = workerVerdict(results);
  verdict.passed &&= !summary.infrastructureError;
  const updated = { ...summary, results, verdict, baseline, maxTelemetryGapMs, analysisHash: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex') };
  writeFileSync(join(output, 'summary.json'), `${JSON.stringify(updated, null, 2)}\n`);
  const rows = results.map((row) => `| ${row.scenario} | ${row.repeat} | ${row.passed ? 'PASS' : 'FAIL'} | ${row.jobs} | ${row.attempts} | ${row.effects} | ${row.overlapMs.toFixed(1)} | ${(row.recoveryMs/1000).toFixed(3)} |`).join('\n');
  writeFileSync(join(output, 'report.md'), `# Worker and singleton experiment\n\n${verdict.complete && summary.settings.fullMatrix && verdict.passed ? 'All 18 expectations met, including two unsafe negative controls.' : 'INCOMPLETE or failing matrix; no full feasibility conclusion.'}\n\nSource ${summary.commit}; ${summary.startedAt}–${summary.finishedAt}; VM ${summary.vm}.\n\n| Case | Repeat | Expectation | Jobs | Attempts | Effects | Owner overlap ms | Work recovery s |\n|---|---:|---|---:|---:|---:|---:|---:|\n${rows}\n\n${results.filter((row) => !row.passed).map((row) => `- ${row.scenario}/${row.repeat}: ${row.reasons.join('; ')}`).join('\n')}\n\nA PASS for effect-without-idempotency means duplicate durable effects occurred. A PASS for singleton-unlocked means two tasks performed exclusive work concurrently. These are unsafe controls, not runtime guarantees. Recovery measures all queued jobs completed or B acquired ownership, from acknowledged injection/update; it is not an HTTP outage measurement.\n\n## Versions and resources\n\n\`\`\`json\n${JSON.stringify({ versions: summary.versions, images: summary.images, resources: summary.resources }, null, 2)}\n\`\`\`\n\n## Reproduce\n\n\`\`\`bash\nbash test/lab/swarm/run.sh --suite workers\nnode test/lab/swarm/workers/results.mjs OUTPUT_DIRECTORY\n\`\`\`\n\nRaw per-case evidence.json contains all jobs, effects, attempts, ownership intervals, ticks, application event history, service snapshots and injection timestamps. Container logs/inspections, Docker events, metrics and commands are retained. No request retries or traffic switcher are involved; workers do not receive HTTP traffic.\n\nThe application fixture owns four-second renewable leases, claim tokens, transactional effect fencing, a unique effect key, and session advisory locking. Singletons report healthy while waiting for ownership, avoiding start-first readiness/ownership deadlock. These are fixture protocols, not a new Kayra contract. PostgreSQL effects and acknowledgements intentionally use separate transactions to expose redelivery; unique effect keys only protect these database effects, not arbitrary external APIs. This does not prove exactly-once job execution, network-partition safety, external-effect fencing, database failover, multi-node scheduling, admission, storage retention, or Kayra release-record recovery.\n\nSources: [Docker update overlap](https://docs.docker.com/reference/compose-file/deploy/#update_config), [PostgreSQL queue locking](https://www.postgresql.org/docs/18/sql-select.html), [application advisory locks](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS).\n`);
  return updated;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = analyzeWorkers(resolve(process.argv[2]));
  console.log(JSON.stringify(summary.verdict));
  process.exitCode = summary.verdict.passed ? 0 : 1;
}
