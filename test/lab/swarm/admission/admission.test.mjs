import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAdmission, admissionVerdict, admissionScenarios } from './results.mjs';
function fixture(scenario='disk-admission') {
  const records=Array.from({length:701},(_,index)=>({kind:'short',at:index*50,endedAt:index*50+1,status:200,body:{release:'A',ready:true,readyAt:0,writeId:`${index}`,value:`value-${index}`,canary:'seed-value',fileCanary:'file-seed-value'}}));
  const service={Version:{Index:1},Spec:{TaskTemplate:{ContainerSpec:{Env:['RELEASE=A']}}}};
  const db={columns:['id','display_name'],rows:[{id:'seed',display_name:'seed-value'},...records.map((row)=>({id:row.body.writeId,display_name:row.body.value}))]};
  const files={canary:'file-seed-value',payloadHash:'unique-payload-hash'};
  const evidence={scenario,repeat:1,before:service,after:service,beforeFiles:files,afterFiles:files,database:db,timeline:[{kind:'experiment-started',at:0}],outcome:{state:'admission_refused',observedAt:0},details:{disk:{code:'ENOSPC',availableBytes:0},admission:{accepted:false,availableBytes:0,requiredBytes:64*1024**2}}};
  return {evidence,records};
}
test('disk admission refusal requires unchanged service and retained acknowledged writes',()=>{
  const {evidence,records}=fixture();assert.equal(assessAdmission(evidence,records).passed,true);
  evidence.after={...evidence.after,Version:{Index:2}};assert.equal(assessAdmission(evidence,records).passed,false);
});
test('successful HTTP cannot conceal a lost persistent file or acknowledged database row',()=>{
  const {evidence,records}=fixture();evidence.afterFiles={...evidence.afterFiles,payloadHash:'wrong'};
  assert.equal(assessAdmission(evidence,records).passed,false);
  evidence.afterFiles=evidence.beforeFiles;evidence.database.rows.pop();assert.equal(assessAdmission(evidence,records).passed,false);
});
test('failed requests and premature candidates fail admission continuity',()=>{
  const {evidence,records}=fixture();records[10].status=503;assert.equal(assessAdmission(evidence,records).passed,false);
  records[10].status=200;records[10].body.ready=false;assert.equal(assessAdmission(evidence,records).passed,false);
});
test('reservation timeout requires pending task and physical pressure evidence',()=>{
  const {evidence,records}=fixture('memory-reservation');
  evidence.details={pendingService:{UpdateStatus:{State:'updating'}},pendingTasks:[{Status:{State:'pending',Err:'no suitable node (insufficient resources on 1 node)'}}],pressureBytes:2.5*1024**3,fillerStats:'reservation-filler.1'};
  evidence.timeline=[{kind:'experiment-started',at:-40000},{kind:'update-acknowledged',at:-40000},{kind:'bounded-cancellation-submitted',at:-5000}];evidence.outcome.state='rollback_completed';
  assert.equal(assessAdmission(evidence,records).passed,true);
  evidence.details.pendingTasks=[];assert.equal(assessAdmission(evidence,records).passed,false);
});
test('explicit purge must preserve unrelated data and recreate an empty database',()=>{
  const {evidence,records}=fixture('purge-guard');
  evidence.details={refused:{code:1,stdout:'still registered',stderr:''},guardFiles:evidence.beforeFiles,guardDatabase:evidence.database,purged:{code:0},volumesAfterPurge:{stdout:'lab-unrelated\n'},unrelated:'unrelated-value',emptyDatabase:'t'};
  assert.equal(assessAdmission(evidence,records).passed,true);
  evidence.details.volumesAfterPurge.stdout+='lab-retention-db\n';assert.equal(assessAdmission(evidence,records).passed,false);
});
test('smoke cannot establish complete admission and retention matrix',()=>{
  const results=admissionScenarios.map((scenario)=>({scenario,repeat:1,passed:true}));assert.equal(admissionVerdict(results).complete,false);
  assert.equal(admissionVerdict([1,2,3].flatMap((repeat)=>results.map((row)=>({...row,repeat})))).complete,true);
});
