import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { assessMigration, migrationVerdict, retentionEvidence } from './results.mjs';

function fixture(scenario = 'transaction-failure') {
  const records = Array.from({ length: 640 }, (_, i) => ({ kind: 'short', at: 2100 + i * 50, endedAt: 2105 + i * 50, status: 200, body: { release: 'A', mode: 'legacy', writeId: `id${i}`, value: `value-id${i}`, canary: 'seed-value', readyAt: 0, requestStartedAt: 2100 + i * 50 } }));
  const service = { Version: { Index: 1 }, Spec: { TaskTemplate: { ContainerSpec: { Env: ['RELEASE=A'] } } } };
  const database = { columns: ['id', 'display_name'], ledger: [], rows: [{ id: 'seed', display_name: 'seed-value' }, ...records.map((row) => ({ id: row.body.writeId, display_name: row.body.value }))] };
  const evidence = { scenario, updateAt: 1000, outcome: { state: 'not-updated', observedAt: 2000 }, before: service, after: structuredClone(service), timeline: [], database, migrations: [{ exitCode: 1, events: [{ kind: 'failed', code: '22012' }] }] };
  return { evidence, records };
}

test('successful HTTP cannot conceal acknowledged write loss or corruption', () => {
  const { evidence, records } = fixture();
  assert.equal(retentionEvidence(records, evidence.database).passed, true);
  evidence.database.rows.pop();
  assert.equal(retentionEvidence(records, evidence.database).passed, false);
  evidence.database.rows[0].display_name = 'wrong';
  assert.equal(retentionEvidence(records, evidence.database).canary, false);
});

test('migration failure must leave both schema and service unchanged', () => {
  const { evidence, records } = fixture();
  assert.equal(assessMigration(evidence, records).passed, true);
  evidence.after.Version.Index = 2;
  assert.equal(assessMigration(evidence, records).passed, false);
  evidence.after.Version.Index = 1;
  evidence.database.columns.push('nickname');
  assert.equal(assessMigration(evidence, records).passed, false);
});

test('expanded schema must preserve legacy values of acknowledged dual writes', () => {
  const { evidence, records } = fixture('expand-rollback');
  evidence.database.columns.push('nickname');
  evidence.database.ledger.push({ version: 'expand' });
  evidence.migrations = [{ exitCode: 0, events: [{ kind: 'applied', migration: 'expand' }] }];
  evidence.timeline = [{ kind: 'update-submitted' }, { kind: 'rollback-submitted' }];
  evidence.candidateOutcome = { state: 'completed' };
  evidence.outcome.state = 'rollback_completed';
  records[0].body.release = 'B';
  records[0].body.mode = 'dual';
  evidence.database.rows[1].nickname = records[0].body.value;
  assert.equal(assessMigration(evidence, records).passed, true);
  evidence.database.rows[1].display_name = 'old-version-cannot-read-this';
  assert.equal(assessMigration(evidence, records).passed, false);
});

test('process death after commit requires persisted ledger and idempotent retry evidence', () => {
  const { evidence, records } = fixture('interrupted-after-commit');
  evidence.database.columns.push('nickname');
  evidence.database.ledger.push({ version: 'expand' });
  evidence.migrations = [{ exitCode: 137, events: [{ kind: 'applied', migration: 'expand' }, { kind: 'committed' }] }, { exitCode: 0, events: [{ kind: 'already-applied' }] }];
  evidence.intermediate = structuredClone(evidence.database);
  assert.equal(assessMigration(evidence, records).passed, true);
  evidence.intermediate.ledger = [];
  assert.equal(assessMigration(evidence, records).passed, false);
});

test('destructive rollback PASS means positively demonstrated incompatibility, not rollback success', () => {
  const { evidence, records } = fixture('destructive-rollback');
  evidence.database.columns = ['id', 'nickname'];
  evidence.database.rows.forEach((row) => { row.nickname = row.display_name; delete row.display_name; });
  evidence.database.ledger = [{ version: 'expand' }, { version: 'contract' }];
  records.forEach((row) => { row.body.release = 'B'; row.body.mode = 'contracted'; });
  records[0].status = 503;
  evidence.migrations = [{ exitCode: 0, events: [{ kind: 'applied', migration: 'expand' }] }, { exitCode: 0, events: [{ kind: 'applied', migration: 'contract' }] }];
  evidence.candidateOutcome = { state: 'completed' };
  evidence.outcome.state = 'rollback_paused';
  evidence.legacyCompatibility = { exitCode: 1, stderr: '42703: column display_name does not exist' };
  assert.equal(assessMigration(evidence, records).passed, true);
  evidence.outcome.state = 'rollback_completed';
  assert.equal(assessMigration(evidence, records).passed, false);
});

test('a partial migration matrix cannot establish feasibility', () => {
  assert.equal(migrationVerdict([{ scenario: 'expand-rollback', repeat: 1, passed: true }]).passed, false);
});
