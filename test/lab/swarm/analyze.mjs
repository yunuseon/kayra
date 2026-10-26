import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assess, verdict } from './results.mjs';

export function routingEvidence(access, service, start, end, mode) {
  const vips = (service.Endpoint?.VirtualIPs ?? []).map((entry) => entry.Addr.split('/')[0]);
  const selected = access.filter((entry) => entry.at >= start && entry.at <= end && entry.RequestHost === 'probe.swarm-lab.test' && entry.ServiceURL);
  const addresses = [...new Set(selected.map((entry) => new URL(entry.ServiceURL).hostname))];
  const expectedLabel = mode === 'vip' ? 'true' : 'false';
  const labelMatches = service.Spec?.Labels?.['traefik.swarm.lbswarm'] === expectedLabel;
  const addressesMatch = addresses.length > 0 && vips.length > 0 && addresses.every((address) => mode === 'vip' ? vips.includes(address) : !vips.includes(address));
  const retried = selected.filter((entry) => Number(entry.RetryAttempts ?? 0) !== 0).length;
  return { passed: labelMatches && addressesMatch && retried === 0, requests: selected.length, addresses, vips, labelMatches, addressesMatch, retried };
}

export function crashEvidence(events, containers, start, end) {
  const candidates = containers.filter((container) => container.Config?.Env?.includes('RELEASE=B'));
  const faults = candidates.flatMap((container) => {
    const selected = events.filter((event) => event.Actor?.ID === container.Id && event.timeNano / 1e6 >= start && event.timeNano / 1e6 <= end);
    const healthy = selected.find((event) => event.Action === 'health_status: healthy');
    const death = selected.find((event) => event.Action === 'die' && event.Actor.Attributes?.exitCode === '42');
    return healthy && death ? [{ container: container.Id, healthyAt: healthy.timeNano / 1e6, diedAt: death.timeNano / 1e6 }] : [];
  });
  return { passed: faults.some((fault) => fault.healthyAt < fault.diedAt), faults };
}

function accessLog(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap((line) => {
    const begin = line.indexOf('{');
    if (begin < 0) return [];
    try {
      const entry = JSON.parse(line.slice(begin));
      return entry.ServiceURL ? [{ ...entry, at: Date.parse(entry.StartUTC) }] : [];
    } catch { return []; }
  });
}

export function analyze(output) {
  const summary = JSON.parse(readFileSync(join(output, 'summary.json'), 'utf8'));
  const access = accessLog(join(output, 'traefik.log'));
  const eventPath = join(output, 'docker-events.ndjson');
  const events = existsSync(eventPath) ? readFileSync(eventPath, 'utf8').split('\n').filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
  const results = summary.results.map((previous) => {
    const path = join(output, `${previous.mode}-${previous.scenario}-${previous.repeat}`);
    const records = readFileSync(join(path, 'requests.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const initial = JSON.parse(readFileSync(join(path, 'initial-task.json'), 'utf8'));
    const service = JSON.parse(readFileSync(join(path, 'service.json'), 'utf8'))[0];
    const routing = routingEvidence(access, service, initial.at, previous.finishedAt, previous.mode);
    const measured = assess({ ...previous, records, observer: previous.observer });
    if (!routing.passed) measured.reasons.push('proxy access logs did not prove the declared discovery mode without retries');
    const fault = previous.scenario === 'crash-after-ready' ? crashEvidence(events, readdirSync(path).filter((name) => /^container-.*\.json$/.test(name)).flatMap((name) => JSON.parse(readFileSync(join(path, name), 'utf8'))), previous.updateAt, previous.finishedAt) : { passed: true };
    if (!fault.passed) measured.reasons.push('missing Docker evidence that candidate became healthy before injected exit 42');
    const result = { ...previous, ...measured, routing, fault, passed: measured.passed && routing.passed && fault.passed };
    writeFileSync(join(path, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  });
  const directory = dirname(fileURLToPath(import.meta.url));
  const analysisSourceHashes = Object.fromEntries(['analyze.mjs', 'results.mjs'].map((name) => [name, createHash('sha256').update(readFileSync(join(directory, name))).digest('hex')]));
  const evidenceComplete = results.every((row) => row.routing.requests > 0 && row.fault.passed);
  const updated = { ...summary, results, verdict: verdict(results), evidenceComplete, analysisSourceHashes, analyzedAt: new Date().toISOString() };
  writeFileSync(join(output, 'summary.json'), `${JSON.stringify(updated, null, 2)}\n`);
  writeFileSync(join(output, 'report.md'), render(updated));
  return updated;
}

function render(summary) {
  const conclusion = summary.infrastructureError || !summary.settings.fullMatrix || !summary.verdict.complete || !summary.evidenceComplete
    ? 'INCOMPLETE: infrastructure and a complete 36-case matrix must be valid before drawing a feasibility conclusion.'
    : summary.verdict.viable
      ? `**Viable discovery mode(s): ${summary.verdict.modes.filter((mode) => mode.passed).map((mode) => mode.mode).join(', ')}.** Advance to migration/worker/admission experiments; this does not select Swarm for production.`
      : '**Neither mode met the continuity/recovery criteria.** Compare the equivalent K3s experiment before extending Swarm integration.';
  const versions = summary.versions ?? {};
  const compactVersions = {
    engine: versions.docker?.Server.Version, dockerCli: versions.docker?.Client.Version,
    api: versions.docker?.Server.ApiVersion, architecture: versions.docker?.Server.Arch,
    compose: versions.compose, os: versions.os?.match(/^PRETTY_NAME="(.*)"$/m)?.[1], kernel: versions.kernel,
    clientNode: versions.node, multipass: versions.multipass,
  };
  const rows = summary.results.map((row) => `| ${row.mode} | ${row.scenario} | ${row.repeat} | ${row.passed ? 'PASS' : 'FAIL'} | ${row.failedRequests}/${row.requests} | ${row.prematureRequests} | ${(row.convergenceMs / 1000).toFixed(1)} | ${(row.longestObservedFailureIntervalMs / 1000).toFixed(2)} |`).join('\n');
  const modeRows = summary.verdict.modes.map((mode) => {
    const selected = summary.results.filter((row) => row.mode === mode.mode);
    return `| ${mode.mode} | ${selected.filter((row) => row.passed).length}/${selected.length} | ${selected.reduce((total, row) => total + row.failedRequests, 0)} | ${mode.complete ? mode.passed ? 'PASS' : 'FAIL' : 'INCOMPLETE'} |`;
  }).join('\n');
  const failures = summary.results.filter((row) => !row.passed).map((row) => `- ${row.mode}/${row.scenario}/${row.repeat}: ${row.reasons.join('; ')}`).join('\n');
  const shellQuote = (value) => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
  return `# Swarm rollout experiment\n\n${conclusion}\n\n${summary.startedAt}–${summary.finishedAt}. VM: ${summary.vm}; Ubuntu 24.04, 2 CPUs, 4 GB RAM, 20 GB disk.\n\n## Environment\n\n\`\`\`json\n${JSON.stringify(compactVersions, null, 2)}\n\`\`\`\n\nImage pins:\n\n\`\`\`json\n${JSON.stringify(summary.images, null, 2)}\n\`\`\`\n\nMeasured source: ${summary.commit}, with the working-tree status and exact source hashes recorded in summary.json. Analysis source hashes are recorded separately.\n\n## Results\n\n| Discovery | Passed cases | Failed requests | Verdict |\n|---|---:|---:|---|\n${modeRows}\n\n| Discovery | Scenario | Repeat | Result | Failed requests | Premature | Convergence s | Longest observed failure interval s |\n|---|---|---:|---|---:|---:|---:|---:|\n${rows}\n\n${failures || 'No scenario failures.'}\n\nEach result also includes routing evidence: service VIPs, actual backend addresses from Traefik access logs, declared discovery mode, and RetryAttempts. A case cannot pass without proving that task discovery used task addresses or VIP discovery used the service VIP.\n\n## Resource samples\n\n\`\`\`json\n${JSON.stringify(summary.resources, null, 2)}\n\`\`\`\n\nThese are minimal-lab VM measurements, not full-platform sizing. Per-container samples remain in metrics.ndjson.\n\n## Reproduction and raw evidence\n\n\`\`\`bash\ncd ${shellQuote(summary.sourceRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../..'))}\nbash test/lab/swarm/run.sh --output /tmp/kayra-swarm-reproduction\n# Recompute assessment from existing raw artifacts:\nnode test/lab/swarm/analyze.mjs ${shellQuote(summary.output)}\n\`\`\`\n\ncommands.ndjson and lab.log record setup/control commands. Per-case directories contain every request, update/observer timeline, service/task snapshots, and fixture container logs/inspections. docker-events.ndjson captures health transitions; traefik.log and socket-proxy.log capture routing/API behavior. summary.json is machine-readable.\n\n## Interpretation limits\n\nA 30-second healthy baseline precedes each mode. Each case verifies the exact initial task identity, sends 20 short requests/s split between fresh/persistent connections without retries, and observes at least 30 seconds after the outcome. Short-request deadlines are two seconds. The post-readiness crash permits disruption but requires automatic recovery within 90 seconds; it is not uninterrupted rollback. Failure intervals are sampled, not exact outage durations.\n\nHTTP only: no TLS, Authelia, migrations, workers, full-platform load, or multi-node availability. Killing the lab observer tests runtime independence, not recovery of Kayra's current release records.\n\n${summary.infrastructureError ? `Infrastructure error: ${summary.infrastructureError}\n` : ''}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('usage: node test/lab/swarm/analyze.mjs OUTPUT_DIRECTORY');
  const summary = analyze(resolve(process.argv[2]));
  console.log(JSON.stringify({ verdict: summary.verdict, infrastructureError: summary.infrastructureError }));
  process.exitCode = summary.infrastructureError || !summary.results.every((row) => row.passed) ? 1 : 0;
}
