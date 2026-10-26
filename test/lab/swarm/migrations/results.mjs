import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { settlement, trafficEvidence } from '../results.mjs';
import { crashEvidence, routingEvidence } from '../analyze.mjs';

export const migrationScenarios = ['expand-rollback', 'transaction-failure', 'concurrent-migrations', 'interrupted-before-commit', 'interrupted-after-commit', 'lock-contention', 'candidate-crash', 'destructive-rollback'];
const releaseOf = (service) => service.Spec.TaskTemplate.ContainerSpec.Env.find((entry) => entry.startsWith('RELEASE='))?.slice(8);
const good = (row) => !row.error && row.status === 200;
const eventsOf = (attempt, kind) => attempt.events.filter((event) => event.kind === kind);

export function retentionEvidence(records, database) {
  const acknowledged = records.filter(good);
  const rows = new Map(database.rows.map((row) => [row.id, row]));
  const invalid = acknowledged.filter((response) => {
    const body = response.body;
    const row = rows.get(body?.writeId);
    if (!row || body.value !== `value-${body.writeId}` || body.canary !== 'seed-value') return true;
    if (database.columns.includes('display_name') && row.display_name !== body.value) return true;
    return (!database.columns.includes('display_name') || body.mode === 'dual') && row.nickname !== body.value;
  });
  const seed = rows.get('seed');
  const canary = (seed?.display_name ?? seed?.nickname) === 'seed-value';
  return { passed: acknowledged.length > 0 && invalid.length === 0 && canary, acknowledged: acknowledged.length, acknowledgedB: acknowledged.filter((row) => row.body?.release === 'B').length, invalid: invalid.length, canary, persisted: database.rows.length - 1, unacknowledged: database.rows.length - 1 - new Set(acknowledged.map((row) => row.body?.writeId)).size };
}

export function assessMigration(evidence, records) {
  const { scenario, outcome, database, migrations, before, after, intermediate, timeline } = evidence;
  const shorts = records.filter((row) => row.kind === 'short');
  const failures = shorts.filter((row) => !good(row));
  const retention = retentionEvidence(shorts, database);
  const traffic = trafficEvidence(shorts);
  const expected = scenario === 'destructive-rollback' ? 'B' : 'A';
  const settled = settlement(shorts, outcome, expected);
  const reasons = [];
  const require = (condition, message) => { if (!condition) reasons.push(message); };
  const expanded = database.columns.includes('nickname');
  const legacy = database.columns.includes('display_name');
  const ledger = database.ledger.map((row) => row.version);
  const applied = migrations.filter((attempt) => attempt.exitCode === 0 || eventsOf(attempt, 'committed').length > 0).flatMap((attempt) => eventsOf(attempt, 'applied'));
  const skipped = migrations.flatMap((attempt) => eventsOf(attempt, 'already-applied'));
  const unchanged = before.Version.Index === after.Version.Index && !timeline.some((row) => row.kind === 'update-submitted');
  const settledInMs = settled.recoveredAt === null ? null : settled.recoveredAt - evidence.updateAt;
  require(traffic.passed, 'load generator did not sustain the required traffic');
  require(retention.passed, 'acknowledged values or canary were lost/corrupted');
  require(settled.stable, 'missing 30 seconds of stable expected-release HTTP');
  require(settledInMs !== null && settledInMs <= 90000, 'HTTP did not settle within 90 seconds of experiment start');
  if (!['candidate-crash', 'destructive-rollback'].includes(scenario)) require(failures.length === 0, 'continuity case had failed requests');
  const premature = shorts.filter((row) => good(row) && row.body?.release === 'B' && row.body?.requestStartedAt < row.body?.readyAt);
  require(premature.length === 0, 'candidate exposed before readiness');
  if (scenario === 'transaction-failure') {
    require(migrations.length === 1 && migrations[0].exitCode !== 0 && migrations[0].events.some((row) => row.code === '22012'), 'missing intentional transactional SQL failure');
    require(!expanded && legacy && ledger.length === 0 && unchanged, 'failed migration changed schema, ledger, or service');
  } else if (scenario === 'lock-contention') {
    require(migrations.some((attempt) => attempt.migration === 'hold-read-lock' && attempt.exitCode === 0 && eventsOf(attempt, 'read-lock-held').length === 1), 'missing held application read lock');
    require(migrations.some((attempt) => attempt.migration === 'expand' && attempt.exitCode !== 0 && attempt.events.some((row) => row.code === '55P03')), 'migration did not hit the declared lock timeout');
    require(!expanded && legacy && ledger.length === 0 && unchanged, 'timed-out migration changed schema, ledger, or service');
  } else {
    require(expanded && ledger.filter((name) => name === 'expand').length === 1, 'expansion or its exactly-once ledger entry missing');
    if (scenario !== 'destructive-rollback') require(legacy && ledger.length === 1 && applied.filter((row) => row.migration === 'expand').length === 1, 'expansion was not applied exactly once with legacy compatibility');
    if (scenario === 'concurrent-migrations') {
      require(migrations.length === 2 && migrations.every((attempt) => attempt.exitCode === 0) && skipped.length === 1 && Math.max(...migrations.map((attempt) => attempt.startedAt)) < Math.min(...migrations.map((attempt) => attempt.finishedAt)), 'concurrent attempts were not overlapping, serialized and idempotent');
      require(unchanged, 'concurrency case unexpectedly updated service');
    } else if (scenario.startsWith('interrupted-')) {
      const killed = migrations.find((attempt) => attempt.exitCode === 137);
      const retried = migrations.find((attempt) => attempt.exitCode === 0);
      require(killed && retried && unchanged, 'missing killed attempt, successful retry, or unchanged service');
      if (scenario === 'interrupted-before-commit') require(intermediate && !intermediate.columns.includes('nickname') && intermediate.ledger.length === 0 && killed?.events.some((row) => row.kind === 'applied') && killed?.events.some((row) => row.kind === 'before-commit-paused') && !killed?.events.some((row) => row.kind === 'committed') && skipped.length === 0, 'pre-commit interruption was not rolled back and reapplied');
      else require(intermediate?.columns.includes('nickname') && intermediate.ledger.length === 1 && killed?.events.some((row) => row.kind === 'committed') && skipped.length === 1, 'post-commit interruption was not recovered from the ledger');
    } else if (scenario === 'candidate-crash') {
      require(outcome.state === 'rollback_completed' && releaseOf(after) === 'A' && !timeline.some((row) => row.kind === 'rollback-submitted'), 'candidate failure did not cause native automatic rollback');
      require(retention.acknowledgedB > 0, 'no acknowledged candidate writes tested across rollback');
    } else if (scenario === 'expand-rollback') {
      require(evidence.candidateOutcome?.state === 'completed' && outcome.state === 'rollback_completed' && releaseOf(after) === 'A' && timeline.some((row) => row.kind === 'rollback-submitted') && retention.acknowledgedB > 0, 'compatible B deployment and explicit A rollback were not proven');
    } else if (scenario === 'destructive-rollback') {
      require(failures.length > 0, 'negative control did not expose the incompatible schema through HTTP');
      require(!legacy && ledger.includes('contract') && migrations.every((attempt) => attempt.exitCode === 0), 'destructive schema change was not committed');
      require(evidence.candidateOutcome?.state === 'completed' && releaseOf(after) === 'A' && outcome.state !== 'rollback_completed' && (outcome.state === 'rollback_paused' || outcome.deadline), 'unsafe image rollback was not attempted and blocked');
      require(evidence.legacyCompatibility?.exitCode !== 0 && /42703/.test(evidence.legacyCompatibility?.stderr ?? ''), 'legacy SQL incompatibility was not positively demonstrated');
    }
  }
  return { scenario, passed: reasons.length === 0, reasons, requests: shorts.length, failedRequests: failures.length, prematureRequests: premature.length, retention, traffic, httpSettlementMs: settledInMs, stableObservationMs: settled.observedForMs, outcome, negativeControl: scenario === 'destructive-rollback', failureStartSpanMs: failures.length ? Math.max(...failures.map((row) => row.at)) - Math.min(...failures.map((row) => row.at)) : 0 };
}

export function migrationVerdict(results) {
  const complete = migrationScenarios.every((scenario) => [1, 2, 3].every((repeat) => results.some((row) => row.scenario === scenario && row.repeat === repeat)));
  return { complete, passed: complete && results.every((row) => row.passed), cases: results.length, expected: 24 };
}

function ndjson(path) {
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line.slice(line.indexOf('{')))]; } catch { return []; } });
}

export function analyzeMigrations(output) {
  const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'));
  if (summary.results.length === 0) {
    writeFileSync(join(output, 'report.md'), `# Shared-database migration experiment\n\nINCOMPLETE: no cases completed. ${summary.infrastructureError ?? ''}\n`);
    return summary;
  }
  const access = ndjson(join(output, 'traefik.log')).map((row) => ({ ...row, at: Date.parse(row.StartUTC) }));
  const events = ndjson(join(output, 'docker-events.ndjson'));
  const results = summary.results.map((previous) => {
    const path = join(output, `vip-${previous.scenario}-${previous.repeat}`);
    const evidence = JSON.parse(readFileSync(join(path, 'evidence.json'), 'utf8'));
    const initial = JSON.parse(readFileSync(join(path, 'initial-task.json'), 'utf8'));
    const records = ndjson(join(path, 'requests.ndjson'));
    const measured = assessMigration(evidence, records);
    const routing = routingEvidence(access, evidence.after, initial.at, evidence.finishedAt, 'vip');
    const fault = previous.scenario === 'candidate-crash' ? crashEvidence(events, readdirSync(path).filter((name) => /^container-.*\.json$/.test(name)).flatMap((name) => JSON.parse(readFileSync(join(path, name), 'utf8'))), evidence.updateAt, evidence.finishedAt) : { passed: true };
    if (!routing.passed) measured.reasons.push('actual VIP routing without retries not proven');
    if (!fault.passed) measured.reasons.push('Docker healthy-before-crash evidence missing');
    const result = { ...previous, ...measured, routing, fault, passed: measured.passed && routing.passed && fault.passed };
    writeFileSync(join(path, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  });
  const valid = !summary.infrastructureError && results.every((row) => row.routing.passed && row.fault.passed && row.traffic.passed);
  const verdict = migrationVerdict(results);
  verdict.passed = verdict.passed && valid;
  const updated = { ...summary, results, verdict, evidenceComplete: valid, analysisHash: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex') };
  writeFileSync(join(output, 'summary.json'), `${JSON.stringify(updated, null, 2)}\n`);
  const conclusion = !valid || !verdict.complete || !summary.settings.fullMatrix ? 'INCOMPLETE: no migration feasibility conclusion.' : verdict.passed ? 'All migration scenarios met their declared expectations, including the unsafe rollback negative control. This supports a gated, application-owned migration protocol, not universal rolling-deployment safety.' : 'One or more migration expectations failed. Inspect raw evidence before integration.';
  const rows = results.map((row) => `| ${row.scenario} | ${row.repeat} | ${row.passed ? 'PASS' : 'FAIL'} | ${row.failedRequests}/${row.requests} | ${row.retention.acknowledged} | ${(row.httpSettlementMs / 1000).toFixed(3)} | ${row.outcome.state} |`).join('\n');
  const report = `# Shared-database migration experiment\n\n${conclusion}\n\n${summary.startedAt}–${summary.finishedAt}; VM ${summary.vm}; source ${summary.commit}.\n\n## Versions\n\n\`\`\`json\n${JSON.stringify({ docker: summary.versions?.docker?.Server.Version, compose: summary.versions?.compose, os: summary.versions?.os, postgres: summary.versions?.postgres, driver: summary.versions?.databaseDriver, images: summary.images }, null, 2)}\n\`\`\`\n\n## Measurements\n\n| Scenario | Repeat | Result | Failed requests | Acknowledged writes retained | HTTP settlement s | Native outcome |\n|---|---:|---|---:|---:|---:|---|\n${rows}\n\n${results.filter((row) => !row.passed).map((row) => `- ${row.scenario}/${row.repeat}: ${row.reasons.join('; ')}`).join('\n')}\n\nFailures in candidate-crash measure disruptive recovery. Failures in destructive-rollback are expected negative-control disruption: committing incompatible DDL cannot be reversed by restoring an image. A negative-control PASS means that incompatibility and blocked A rollback were demonstrated while B continued serving; it does not mean rollback succeeded.\n\nAll successful responses identify a committed write. Every acknowledged ID/value and the seed canary are checked against PostgreSQL after the scenario. Extra rows from readiness probes or unacknowledged requests are reported, not called data loss or exactly-once delivery.\n\n## Resources\n\n\`\`\`json\n${JSON.stringify(summary.resources, null, 2)}\n\`\`\`\n\n## Reproduction\n\n\`\`\`bash\nbash test/lab/swarm/run.sh --suite migrations\n\`\`\`\n\nEach case includes requests.ndjson, evidence.json (database rows/schema/ledger, migration events and service snapshots), migrator inspections/logs, task/container snapshots and PostgreSQL logs. Shared Docker events and full Traefik logs prove native health and actual VIP routing. Source hashes and all commands are recorded in summary.json and commands.ndjson. Successful VMs are destroyed unless --keep; failed labs print cleanup instructions.\n\n## Limits\n\nThis is an app fixture, not a new Kayra app contract or production deployer implementation. The lab runner gates service updates on successful one-shot migration exit; Swarm does not provide that gate. The fixture owns SQL, advisory locking, transaction boundaries, ledger/checksums and dual writes. PostgreSQL transactional DDL is not representative of every database or migration operation. Nontransactional DDL, external side effects, real application backfills and workload sizes remain untested. Single-node HTTP only; worker/singleton behavior, database failover, backup restore and existing Kayra release-record recovery remain subsequent experiments.\n`;
  writeFileSync(join(output, 'report.md'), report);
  return updated;
}


if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('usage: node test/lab/swarm/migrations/results.mjs OUTPUT_DIRECTORY');
  const summary = analyzeMigrations(resolve(process.argv[2]));
  console.log(JSON.stringify({ verdict: summary.verdict, evidenceComplete: summary.evidenceComplete, infrastructureError: summary.infrastructureError }));
  process.exitCode = summary.infrastructureError || summary.results.some((row) => !row.passed) ? 1 : 0;
}
