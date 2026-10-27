import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareMigrations } from '../migrations/runner.mjs';
import { traffic, request } from '../probe.mjs';
import { settlement, trafficEvidence } from '../results.mjs';
import { assessAdmission, admissionScenarios, admissionVerdict } from './results.mjs';
const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../../..');
export const scenarios = admissionScenarios;
const project = 'retention-lab';
const dbVolume = 'lab-retention-db';
const dataVolume = 'lab-retention-files';
const save = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const query = async (ctx, sql) => (await ctx.docker(['exec', '-e', 'PGPASSWORD=lab-only-password', 'lab-db', 'psql', '-h', '127.0.0.1', '-U', 'lab', '-d', 'lab', '-X', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql])).stdout.trim();
async function until(ctx, read, label, timeout = 90000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await ctx.sleep(500); }
  throw new Error(`${label} exceeded ${timeout}ms`);
}
const helper = async (ctx, code, mounts = [], options = {}) => await ctx.docker(['run', '--rm', '--network', 'none', '--memory', '128m', '--user', '0:0', ...mounts.flatMap((mount) => ['--mount', mount]), '--entrypoint', 'node', ctx.metadata.images.node, '-e', code], options);
const files = async (ctx) => JSON.parse((await helper(ctx, "const fs=require('fs'),crypto=require('crypto');console.log(JSON.stringify({canary:fs.readFileSync('/data/canary','utf8'),payloadHash:crypto.createHash('sha256').update(fs.readFileSync('/data/payload')).digest('hex')}))", [`type=volume,src=${dataVolume},dst=/data,readonly`])).stdout);
const database = async (ctx) => ({ columns: ['id','display_name'], rows: JSON.parse(await query(ctx, "SELECT coalesce(json_agg(t),'[]') FROM (SELECT * FROM items ORDER BY id) t")) });
const inspect = async (ctx) => (await ctx.parseRemote(['service', 'inspect', 'probe']))[0];
const nodeState = async (ctx) => await ctx.parseRemote(['node', 'inspect', 'self']);
const pressureMount = 'type=volume,src=lab-pressure,dst=/scratch';
async function emptyPressure(ctx) {
  await helper(ctx, "const fs=require('fs');for(const name of ['pressure','candidate'])fs.rmSync('/scratch/'+name,{force:true})", [pressureMount]);
}
async function fillPressure(ctx) {
  return JSON.parse((await helper(ctx, "const fs=require('fs');const fd=fs.openSync('/scratch/pressure','w');let written=0;try{for(;;)written+=fs.writeSync(fd,Buffer.alloc(1024*1024,90))}catch(e){if(e.code!=='ENOSPC')throw e;fs.closeSync(fd);const s=fs.statfsSync('/scratch');console.log(JSON.stringify({code:e.code,written,availableBytes:s.bavail*s.bsize}))}", [pressureMount])).stdout);
}
async function startDatabase(ctx) {
  await ctx.docker(['volume', 'create', '--label', `com.docker.compose.project=${project}`, dbVolume]);
  await ctx.docker(['run', '-d', '--name', 'lab-db', '--network', 'lab-data', '--memory', '512m', '-v', `${dbVolume}:/var/lib/postgresql`, '-e', 'POSTGRES_USER=lab', '-e', 'POSTGRES_PASSWORD=lab-only-password', '-e', 'POSTGRES_DB=lab', ctx.metadata.images.postgres]);
  await until(ctx, async () => { try { return await query(ctx, 'SELECT 1') === '1'; } catch { return false; } }, 'database ready', 60000);
}
export async function prepareAdmission(ctx) {
  await prepareMigrations({ ...ctx, databaseVolume: dbVolume, databaseVolumeLabels: [`com.docker.compose.project=${project}`] });
  ctx.metadata.admissionSourceHashes = Object.fromEntries(['runner.mjs','fixture.mjs','results.mjs'].map((name) => [name, createHash('sha256').update(readFileSync(join(directory,name))).digest('hex')]));
  ctx.metadata.purgeSourceHash = createHash('sha256').update(readFileSync(join(root,'scripts/server/app-purge'))).digest('hex');
  await ctx.run('multipass', ['transfer', join(directory,'fixture.mjs'), `${ctx.metadata.vm}:/home/ubuntu/swarm-lab/migrations/fixture.mjs`]);
  ctx.metadata.images.admissionFixture = `kayra-swarm-admission:${ctx.metadata.vm.replace('kayra-swarm-lab-','')}`;
  await ctx.docker(['build','-t',ctx.metadata.images.admissionFixture,'/home/ubuntu/swarm-lab/migrations'],{timeout:600000});
  ctx.metadata.imageInspections.push(...await ctx.parseRemote(['image','inspect',ctx.metadata.images.admissionFixture]));
  await ctx.remote(['sudo','bash','-s'],{input:`set -euo pipefail\ntruncate -s 256M /home/ubuntu/swarm-lab/pressure.img\nmkfs.ext4 -q -m 0 /home/ubuntu/swarm-lab/pressure.img\nmkdir -p /home/ubuntu/swarm-lab/pressure\nmount -o loop /home/ubuntu/swarm-lab/pressure.img /home/ubuntu/swarm-lab/pressure\nchmod 777 /home/ubuntu/swarm-lab/pressure\nmkdir -p /home/ubuntu/swarm-lab/purge-platform/bin /home/ubuntu/swarm-lab/purge-platform/apps\n`});
  await ctx.docker(['volume','create','--driver','local','--opt','type=none','--opt','o=bind','--opt','device=/home/ubuntu/swarm-lab/pressure','lab-pressure']);
  await ctx.run('multipass',['transfer',join(root,'scripts/server/app-purge'),`${ctx.metadata.vm}:/home/ubuntu/swarm-lab/purge-platform/bin/app-purge`]);
  await ctx.remote(['chmod','755','/home/ubuntu/swarm-lab/purge-platform/bin/app-purge']);
  await ctx.docker(['volume','create','--label','com.docker.compose.project=unrelated-lab','lab-unrelated']);
  await helper(ctx,"require('fs').writeFileSync('/other/canary','unrelated-value')",['type=volume,src=lab-unrelated,dst=/other']);
}
async function removeService(ctx) {
  await ctx.docker(['service','rm','probe'],{allowFailure:true});
  await until(ctx,async()=>!(await ctx.docker(['ps','-q','--filter','label=com.docker.swarm.service.name=probe'])).stdout.trim(),'service shutdown',45000);
}
async function createService(ctx) {
  await ctx.docker(['service','create','--detach','--name','probe','--replicas','1','--no-resolve-image','--network','lab-public','--network','lab-data',
    '--mount',`type=volume,src=${dataVolume},dst=/data`,'--mount',pressureMount,'--limit-memory','256m','--reserve-memory','256m',
    '--update-order','start-first','--update-monitor','30s','--update-failure-action','rollback','--update-max-failure-ratio','0','--rollback-order','start-first','--rollback-monitor','5s','--stop-grace-period','30s','--restart-delay','1s',
    '--health-cmd','node /app/fixture.mjs health','--health-interval','1s','--health-timeout','1s','--health-retries','2','--health-start-period','5s',
    '--env','DATABASE_URL=postgres://lab:lab-only-password@lab-db:5432/lab','--env','RELEASE=A','--env','SCHEMA_MODE=legacy','--env','STARTUP_FAULT=none',
    '--label','traefik.enable=true','--label','traefik.swarm.network=lab-public','--label','traefik.swarm.lbswarm=true','--label','traefik.http.routers.probe.rule=Host(`probe.swarm-lab.test`)','--label','traefik.http.routers.probe.entrypoints=web','--label','traefik.http.routers.probe.service=probe','--label','traefik.http.services.probe.loadbalancer.server.port=8080',ctx.metadata.images.admissionFixture]);
  return await ctx.waitForA();
}
async function reset(ctx) {
  await removeService(ctx);
  await ctx.docker(['service','rm','reservation-filler'],{allowFailure:true});
  await emptyPressure(ctx);
  const pg = await ctx.docker(['inspect','lab-db'],{allowFailure:true});
  if (pg.code !== 0) await startDatabase(ctx);
  await query(ctx,"DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE TABLE items(id text PRIMARY KEY,display_name text NOT NULL); INSERT INTO items VALUES('seed','seed-value')");
  await ctx.docker(['volume','create','--label',`com.docker.compose.project=${project}`,dataVolume]);
  await helper(ctx,"const fs=require('fs');fs.writeFileSync('/data/canary','file-seed-value');fs.writeFileSync('/data/payload',require('crypto').randomBytes(1024*1024));fs.chmodSync('/data',0o777)",[`type=volume,src=${dataVolume},dst=/data`]);
  return await createService(ctx);
}
async function runtime(ctx, expected, path, label) {
  return await until(ctx,async()=>{
    const service=await inspect(ctx); appendFileSync(join(path,'observations.ndjson'),JSON.stringify({at:Date.now(),label,service})+'\n');
    if (['paused','rollback_paused'].includes(service.UpdateStatus?.State)) throw new Error(`unexpected ${service.UpdateStatus.State}`);
    return service.UpdateStatus?.State===expected && service.Spec.TaskTemplate.ContainerSpec.Env.includes(`RELEASE=${expected==='completed'?'B':'A'}`) ? {state:expected,observedAt:Date.now()} : false;
  },label);
}
async function update(ctx, args=[]) { ctx.admissionActionAt=Date.now(); await ctx.docker(['service','update','--detach',...args,'probe']); }
async function runCase(ctx, scenario, repeat) {
  const path=join(ctx.output,`${scenario}-${repeat}`);mkdirSync(path);ctx.progress(`admission ${scenario}/${repeat}`);
  const initial=await reset(ctx), before=await inspect(ctx), beforeFiles=await files(ctx);
  save(join(path,'initial-task.json'),initial);
  const records=[],timeline=[], details={};
  const mark=(kind,fields={})=>{const row={kind,at:Date.now(),...fields};timeline.push(row);appendFileSync(join(path,'timeline.ndjson'),JSON.stringify(row)+'\n')};
  let stopped=false;
  const stop=traffic(`${ctx.target}/version`,(row)=>{records.push(row);appendFileSync(join(path,'requests.ndjson'),JSON.stringify(row)+'\n')});
  let outcome,after, finalDatabase, afterFiles;
  try {
    await ctx.sleep(5000);mark('experiment-started');
    if(scenario==='memory-reservation') {
      details.node=(await nodeState(ctx))[0];
      const reserved=details.node.Description.Resources.MemoryBytes-384*1024*1024;
      const pressureBytes=Math.floor((details.node.Description.Resources.MemoryBytes-1280*1024*1024)/(16*1024*1024))*16*1024*1024;
      details.pressureBytes=pressureBytes;
      await ctx.docker(['service','create','--detach','--name','reservation-filler','--reserve-memory',String(reserved),'--limit-memory',String(reserved),'--no-resolve-image',ctx.metadata.images.node,'node','-e',`const held=[];for(let i=0;i<${pressureBytes}/16777216;i++)held.push(Buffer.alloc(16777216,90));console.log('pressure-ready');setInterval(()=>{},1000)`]);
      await until(ctx,async()=>(await ctx.docker(['service','ps','--format','{{.CurrentState}}','reservation-filler'])).stdout.includes('Running'),'reservation filler running');
      await until(ctx,async()=>(await ctx.docker(['service','logs','reservation-filler'],{allowFailure:true})).stdout.includes('pressure-ready'),'physical memory pressure ready');
      details.fillerStats=(await ctx.docker(['stats','--no-stream','--format','{{json .}}'])).stdout;
      details.filler=(await ctx.parseRemote(['service','inspect','reservation-filler']))[0];
      mark('update-submitted');await update(ctx,['--env-add','RELEASE=B']);mark('update-acknowledged');
      await ctx.sleep(35000);
      details.pendingService=await inspect(ctx);
      details.pendingTasks=await ctx.parseRemote(['inspect','--type','task',...(await ctx.docker(['service','ps','-q','probe'])).stdout.trim().split('\n').filter(Boolean)]);
      mark('bounded-cancellation-submitted');ctx.admissionActionAt=Date.now();await ctx.docker(['service','rollback','--detach','probe']);mark('bounded-cancellation-acknowledged');
      await ctx.docker(['service','rm','reservation-filler']);
      outcome=await runtime(ctx,'rollback_completed',path,'cancel pending candidate');
    } else if(scenario==='candidate-oom'||scenario==='candidate-enospc') {
      if(scenario==='candidate-enospc') details.disk=await fillPressure(ctx);
      mark('update-submitted');await update(ctx,['--env-add','RELEASE=B','--env-add',`STARTUP_FAULT=${scenario==='candidate-oom'?'oom':'disk'}`,...(scenario==='candidate-oom'?['--limit-memory','128m','--reserve-memory','64m']:[])]);mark('update-acknowledged');
      outcome=await runtime(ctx,'rollback_completed',path,'automatic rollback');
    } else if(scenario==='disk-admission') {
      details.disk=await fillPressure(ctx);
      details.admission={requiredBytes:64*1024*1024,availableBytes:details.disk.availableBytes,accepted:details.disk.availableBytes>=64*1024*1024};
      if(details.admission.accepted) throw new Error('disk admission fixture unexpectedly accepted full filesystem');
      mark('admission-refused',details.admission); outcome={state:'admission_refused',observedAt:Date.now()};
    } else if(scenario==='retention-lifecycle') {
      mark('update-submitted');await update(ctx,['--env-add','RELEASE=B']);mark('update-acknowledged');
      await runtime(ctx,'completed',path,'healthy B');
      await until(ctx,async()=>records.filter((row)=>row.status===200&&row.body?.release==='B').length>=20,'B acknowledged writes');
      details.afterB=await database(ctx);
      mark('manual-rollback-submitted');ctx.admissionActionAt=Date.now();await ctx.docker(['service','rollback','--detach','probe']);
      await runtime(ctx,'rollback_completed',path,'rollback to A');
      mark('failed-update-submitted');await update(ctx,['--env-add','RELEASE=B','--env-add','STARTUP_FAULT=never']);
      outcome=await runtime(ctx,'rollback_completed',path,'never-ready rollback');
    } else {
      await ctx.remote(['tee','/home/ubuntu/swarm-lab/purge-platform/apps/retention-lab.json'],{input:'{}\n'});
      details.refused=await ctx.remote(['sudo','/home/ubuntu/swarm-lab/purge-platform/bin/app-purge',project],{allowFailure:true});
      details.guardFiles=await files(ctx); details.guardDatabase=await database(ctx);
      mark('registered-purge-refused');outcome={state:'purge_refused',observedAt:Date.now()};
    }
    while(!settlement(records,outcome,'A').stable&&Date.now()<outcome.observedAt+70000)await ctx.sleep(500);
    after=await inspect(ctx);await ctx.snapshot(path);
    await stop();stopped=true;mark('traffic-stopped');
    finalDatabase=await database(ctx);afterFiles=await files(ctx);
    if(scenario==='retention-lifecycle') {
      details.preRemove={database:finalDatabase,files:afterFiles};
      mark('intentional-removal');await removeService(ctx);
      details.volumesAfterRemove=await ctx.parseRemote(['volume','inspect',dbVolume,dataVolume]);
      await ctx.docker(['stop','--time','30','lab-db']);await ctx.docker(['rm','lab-db']);await startDatabase(ctx);
      details.afterDatabaseRestart=await database(ctx);
      details.recreated=await createService(ctx);
      details.recreatedResponse=await request(`${ctx.target}/version`);
      finalDatabase=await database(ctx);afterFiles=await files(ctx);
      mark('recreated');
    }
    if(scenario==='purge-guard') {
      mark('intentional-removal');await removeService(ctx);
      await ctx.docker(['stop','--time','30','lab-db']);await ctx.docker(['rm','lab-db']);
      // Remove stopped service containers so volume-in-use protection is no longer relevant.
      const ids=(await ctx.docker(['ps','-aq','--filter','label=com.docker.swarm.service.name=probe'])).stdout.trim().split('\n').filter(Boolean);
      if(ids.length)await ctx.docker(['rm',...ids]);
      await ctx.remote(['rm','/home/ubuntu/swarm-lab/purge-platform/apps/retention-lab.json']);mark('explicit-purge-submitted');
      details.purged=await ctx.remote(['sudo','/home/ubuntu/swarm-lab/purge-platform/bin/app-purge',project],{allowFailure:true});
      details.volumesAfterPurge=await ctx.docker(['volume','ls','--format','{{.Name}}']);
      details.unrelated=(await helper(ctx,"console.log(require('fs').readFileSync('/other/canary','utf8'))",['type=volume,src=lab-unrelated,dst=/other,readonly'])).stdout.trim();
      await startDatabase(ctx);details.emptyDatabase=await query(ctx,"SELECT to_regclass('public.items') IS NULL");mark('purged');
    }
  } finally {if(!stopped)await stop();await emptyPressure(ctx);await ctx.docker(['service','rm','reservation-filler'],{allowFailure:true});}
  const evidence={scenario,repeat,initial,before,after,beforeFiles,afterFiles,database:finalDatabase,details,timeline,outcome,finishedAt:Date.now()};
  save(join(path,'evidence.json'),evidence);
  const result=assessAdmission(evidence,records);ctx.results.push(result);save(join(path,'result.json'),result);
  save(join(ctx.output,'summary.json'),{...ctx.metadata,verdict:admissionVerdict(ctx.results),finishedAt:null});
  ctx.progress(`${scenario}/${repeat}: ${result.passed?'PASS':'FAIL'} (${result.failedRequests}/${result.requests} failed) ${result.reasons.join('; ')}`);
  if(!result.traffic.passed)throw new Error('traffic interruption invalidated measurement');
}
export async function runAdmission(ctx) {
  await reset(ctx);ctx.progress('admission 30-second baseline');const baseline=[];
  const stop=traffic(`${ctx.target}/version`,(row)=>{baseline.push(row);appendFileSync(join(ctx.output,'baseline.ndjson'),JSON.stringify(row)+'\n')});
  try{await ctx.sleep(31000)}finally{await stop()}
  if(!trafficEvidence(baseline).passed||baseline.some((row)=>row.error||row.status!==200||!row.body?.ready))throw new Error('unhealthy or interrupted baseline');
  for(let repeat=1;repeat<=ctx.settings.repeats;repeat++)for(const scenario of ctx.settings.scenarios)await runCase(ctx,scenario,repeat);
}
