import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { settlement, trafficEvidence } from '../results.mjs';
import { routingEvidence } from '../analyze.mjs';
import { retentionEvidence } from '../migrations/results.mjs';
export const admissionScenarios=['memory-reservation','candidate-oom','disk-admission','candidate-enospc','retention-lifecycle','purge-guard'];
const release=(service)=>service.Spec.TaskTemplate.ContainerSpec.Env.find((entry)=>entry.startsWith('RELEASE='))?.slice(8);
export function assessAdmission(e,records) {
  const reasons=[];const require=(ok,reason)=>{if(!ok)reasons.push(reason)};
  const short=records.filter((row)=>row.kind==='short');
  const good=(row)=>!row.error&&row.status===200;
  const failed=short.filter((row)=>!good(row));
  const premature=short.filter((row)=>good(row)&&(!row.body.ready||row.body.readyAt===null));
  const traffic=trafficEvidence(records), stable=settlement(records,e.outcome,'A');
  const retained=retentionEvidence(records,e.database);
  require(traffic.passed,'interrupted or insufficient load');require(failed.length===0,'failed requests during continuity window');
  require(premature.length===0,'premature candidate exposure');require(stable.stable,'missing 30-second stable A tail');
  require(retained.passed,'acknowledged database writes missing or corrupted');
  require(e.beforeFiles.canary==='file-seed-value'&&e.afterFiles.canary===e.beforeFiles.canary&&e.afterFiles.payloadHash===e.beforeFiles.payloadHash,'persistent files changed or disappeared');
  require(short.filter(good).every((row)=>row.body.fileCanary==='file-seed-value'),'HTTP file canary mismatch');
  const d=e.details;
  if(e.scenario==='memory-reservation') {
    require(d.pendingService?.UpdateStatus?.State==='updating','pending update not observed');
    require(d.pendingTasks?.some((task)=>task.Status.State==='pending'&&/insufficient resources/i.test(task.Status.Err)),'unschedulable task proof missing');
    const start=e.timeline.find((row)=>row.kind==='update-acknowledged')?.at;
    const cancel=e.timeline.find((row)=>row.kind==='bounded-cancellation-submitted')?.at;
    require(cancel-start>=35000,'candidate not observed pending beyond failure monitor');
    require(d.pressureBytes>2*1024**3&&d.fillerStats?.includes('reservation-filler'),'physical memory pressure proof missing');
    require(e.outcome.state==='rollback_completed','bounded cancellation did not restore A');
  } else if(['candidate-oom','candidate-enospc'].includes(e.scenario)) {
    require(e.outcome.state==='rollback_completed','candidate failure did not automatically roll back');
    if(e.scenario==='candidate-enospc')require(d.disk.code==='ENOSPC'&&d.disk.availableBytes<1024*1024,'disk not exhausted');
  } else if(e.scenario==='disk-admission') {
    require(d.disk.code==='ENOSPC'&&!d.admission.accepted&&d.admission.availableBytes<d.admission.requiredBytes,'disk admission refusal absent');
    require(e.before.Version.Index===e.after.Version.Index&&release(e.after)==='A','refused admission mutated service');
    require(!e.timeline.some((row)=>row.kind==='update-submitted'),'refused admission submitted an update');
  } else if(e.scenario==='retention-lifecycle') {
    require(short.some((row)=>good(row)&&row.body.release==='B'),'B did not acknowledge writes');
    require(d.volumesAfterRemove?.length===2,'named volumes did not survive service removal');
    require(d.recreatedResponse?.status===200&&d.recreatedResponse.body?.release==='A','removed application did not recreate');
    require(retentionEvidence(records,d.afterDatabaseRestart).passed,'data lost across database recreation');
  } else {
    require(d.refused?.code===1&&`${d.refused?.stdout}${d.refused?.stderr}`.includes('still registered'),'registered purge not refused');
    require(d.guardFiles?.payloadHash===e.beforeFiles.payloadHash&&d.guardFiles?.canary===e.beforeFiles.canary,'purge guard changed files');
    require(d.guardDatabase?.rows.some((row)=>row.id==='seed'&&row.display_name==='seed-value'),'purge guard lost database');
    const names=d.volumesAfterPurge?.stdout.split('\n');
    require(d.purged?.code===0&&!names?.includes('lab-retention-db')&&!names?.includes('lab-retention-files'),'explicit purge did not remove intended volumes');
    require(names?.includes('lab-unrelated')&&d.unrelated==='unrelated-value','purge damaged unrelated data');
    require(d.emptyDatabase==='t','purged database did not recreate empty');
  }
  if(e.scenario!=='retention-lifecycle')require(short.filter(good).every((row)=>row.body.release==='A'),'rejected candidate received requests');
  require(release(e.after)==='A','final release is not A');
  const started=e.timeline.find((row)=>row.kind==='experiment-started')?.at;
  const action=e.timeline.find((row)=>row.kind==='failed-update-submitted'||row.kind==='bounded-cancellation-submitted'||row.kind==='update-submitted')?.at??started;
  require(e.outcome.observedAt-action<=90000,'action did not settle within 90 seconds');
  return {scenario:e.scenario,repeat:e.repeat,passed:reasons.length===0,reasons,requests:short.length,failedRequests:failed.length,prematureRequests:premature.length,traffic,retention:retained,stableObservationMs:stable.observedForMs,outcome:e.outcome,actionSettlementMs:e.outcome.observedAt-action};
}
export function admissionVerdict(results) {
  return {complete:admissionScenarios.every((scenario)=>[1,2,3].every((repeat)=>results.some((row)=>row.scenario===scenario&&row.repeat===repeat))),passed:results.length>0&&results.every((row)=>row.passed),cases:results.length,passedCases:results.filter((row)=>row.passed).length};
}
const lines=(path)=>!existsSync(path)?[]:readFileSync(path,'utf8').split('\n').flatMap((line)=>{try{return[JSON.parse(line.slice(line.indexOf('{')))]}catch{return[]}});
export function analyzeAdmission(output) {
  const summary=JSON.parse(readFileSync(join(output,'summary.json'),'utf8'));
  const access=lines(join(output,'traefik.log')).map((row)=>({...row,at:Date.parse(row.StartUTC)}));
  const events=lines(join(output,'docker-events.ndjson'));
  const results=summary.results.map((previous)=>{
    const path=join(output,`${previous.scenario}-${previous.repeat}`);
    const e=JSON.parse(readFileSync(join(path,'evidence.json'),'utf8'));
    const result=assessAdmission(e,lines(join(path,'requests.ndjson')));
    const trafficStoppedAt=e.timeline.find((row)=>row.kind==='traffic-stopped')?.at??e.finishedAt;
    result.routing=routingEvidence(access,e.after,e.initial.at,trafficStoppedAt,'vip');
    if(e.details.recreatedService){
      result.recreatedRouting=routingEvidence(access,e.details.recreatedService,e.details.recreated.at,e.finishedAt,'vip');
      if(!result.recreatedRouting.passed)result.reasons.push('recreated-service VIP routing not proven');
    }
    if(!result.routing.passed)result.reasons.push('VIP routing without retries not proven');
    const containers=readdirSync(path).filter((name)=>/^container-.*\.json$/.test(name)).flatMap((name)=>JSON.parse(readFileSync(join(path,name),'utf8')));
    const faultType=previous.scenario==='candidate-oom'?'oom':previous.scenario==='candidate-enospc'?'disk':previous.scenario==='retention-lifecycle'?'never':null;
    if(faultType){
      const candidates=containers.filter((c)=>c.Config.Env.includes('RELEASE=B')&&c.Config.Env.includes(`STARTUP_FAULT=${faultType}`));
      const proven=candidates.some((c)=>{
        if(faultType==='oom')return c.State.OOMKilled&&c.State.ExitCode===137&&events.some((row)=>row.Action==='oom'&&row.Actor?.ID===c.Id);
        if(faultType==='never')return c.State.Health?.Log.some((row)=>row.ExitCode===1);
        const log=readFileSync(join(path,`container-${c.Id.slice(0,12)}.log`),'utf8');
        return c.State.ExitCode===42&&log.includes('"code":"ENOSPC"');
      });
      result.fault={type:faultType,passed:proven};if(!proven)result.reasons.push(`${faultType} fault not positively proven`);
    }
    result.passed=result.reasons.length===0;writeFileSync(join(path,'result.json'),JSON.stringify(result,null,2)+'\n');return result;
  });
  const baseline=lines(join(output,'baseline.ndjson'));
  if(results.length&&(!trafficEvidence(baseline).passed||baseline.length<600||baseline.some((row)=>row.error||row.status!==200||!row.body?.ready)))summary.infrastructureError??='baseline replay rejected';
  const metrics=lines(join(output,'metrics.ndjson')).filter((row)=>row.kind==='vm');
  const maxTelemetryGapMs=metrics.reduce((max,row,index)=>index?Math.max(max,row.at-metrics[index-1].at):max,0);
  if(results.length&&(metrics.length<2||maxTelemetryGapMs>15000))summary.infrastructureError??='telemetry interrupted';
  const verdict=admissionVerdict(results);verdict.passed&&=!summary.infrastructureError;
  const updated={...summary,results,verdict,maxTelemetryGapMs,analysisHash:createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')};
  writeFileSync(join(output,'summary.json'),JSON.stringify(updated,null,2)+'\n');
  const rows=results.map((row)=>`| ${row.scenario} | ${row.repeat} | ${row.passed?'PASS':'FAIL'} | ${row.failedRequests}/${row.requests} | ${row.retention.acknowledged} | ${row.outcome.state} |`).join('\n');
  writeFileSync(join(output,'report.md'),`# Admission and retention experiment\n\n${verdict.complete&&summary.settings.fullMatrix&&verdict.passed?'All 18 declared expectations met.':'INCOMPLETE or failing matrix; no full feasibility conclusion.'}\n\nSource ${summary.commit}; ${summary.startedAt}–${summary.finishedAt}; VM ${summary.vm}.\n\n| Case | Repeat | Result | Failed requests | Retained acknowledged writes | Outcome |\n|---|---:|---|---:|---:|---|\n${rows}\n\n${results.filter((row)=>!row.passed).map((row)=>`- ${row.scenario}/${row.repeat}: ${row.reasons.join('; ')}`).join('\n')}\n\n## Environment\n\n\`\`\`json\n${JSON.stringify({versions:summary.versions,images:summary.images,resources:summary.resources},null,2)}\n\`\`\`\n\n## Reproduction\n\n\`\`\`bash\nbash test/lab/swarm/run.sh --suite admission\nnode test/lab/swarm/admission/results.mjs OUTPUT_DIRECTORY\n\`\`\`\n\nEach case records requests, all acknowledged database values, persistent-file hashes, timeline, task/service/container state, faults and retention/purge outcomes. Docker events and access logs independently prove OOM and VIP routing without retries.\n\nReservations model scheduler accounting; the filler also touches over 2 GiB of real memory. Pending updates are explicitly cancelled by a bounded lab coordinator; Swarm does not supply this deadline. Candidate OOM is cgroup-scoped, not a global kernel-OOM test. Disk admission is a lab policy on a bounded 256 MiB filesystem; ENOSPC does not fill Docker's root filesystem. Planned removal/database restart/purge occur after the continuity traffic stops.\n\nPurge uses the existing app-purge script with explicit Compose-compatible ownership labels on fixture volumes. Application removal uses native service removal; Kayra's Compose app-remove cannot be assumed to manage Swarm. The production deployer and app contract are unchanged. No claims cover global OOM, Docker-root/inode exhaustion, concurrent admission races, resource prediction, backups, host loss, multi-node volume placement, TLS or release-record recovery.\n`);
  return updated;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const summary=analyzeAdmission(resolve(process.argv[2]));console.log(JSON.stringify(summary.verdict));process.exitCode=summary.verdict.passed?0:1;
}
