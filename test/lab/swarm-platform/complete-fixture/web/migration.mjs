// App-owned fixture state and recovery; the coordinator sees only exit status or the probe contract.
const operation = process.env.KAYRA_OPERATION_ID;
if (!operation || !process.env.DB_HOST) throw new Error('missing fixture operation identity or ledger');
const probe = process.argv[2] === 'probe';
const response = await fetch(`http://${process.env.DB_HOST}:${process.env.DB_PORT ?? 8080}/${probe ? 'probe?mode=known' : 'apply?safe=0'}`, {
  method: probe ? 'GET' : 'POST', headers: { 'x-operation': operation }, signal: AbortSignal.timeout(4000),
});
if (!response.ok) throw new Error('fixture ledger unavailable');
const value = await response.json();
if (probe) {
  if (value.version !== 1 || !['applied', 'not-applied', 'unknown'].includes(value.outcome)) throw new Error('invalid fixture ledger outcome');
  process.stdout.write(JSON.stringify(value) + '\n');
} else {
  const hold = Number(process.env.MIGRATION_HOLD_MS ?? 0);
  if (!Number.isSafeInteger(hold) || hold < 0 || hold > 30000) throw new Error('invalid fixture hold');
  if (hold) await new Promise((resolve) => setTimeout(resolve, hold));
  process.exitCode = process.env.FAIL_AFTER_EFFECT === 'true' ? 1 : 0;
}
