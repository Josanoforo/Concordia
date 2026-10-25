import test from 'node:test';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { legacyRelationContract } from '../src/relations/legacy.ts';
import { planProbe, executeProbe, type ProbeAdapter, type ProbeReadRequest } from '../src/relations/probes.ts';
import { evaluateRelation } from '../src/relations/decision.ts';
import { ROOT, SafeError } from '../src/runtime.ts';
import type { RelationPolicy } from '../src/relations/decision.ts';
import { recordFreshnessAttempt, recordFreshnessPreflightFailure, freshnessHistoryView, readFreshnessHistory, replayFreshnessAttempt, type SourceSchemaFingerprint } from '../src/reconcile/freshness-history.ts';
import { assertFreshnessRelationSupported, resolveFreshnessRelationId } from '../src/reconcile/freshness-scope.ts';
import { assessConsumerInputVersions, consumerFreshnessSnapshot } from '../src/reconcile/consumer-freshness.ts';
import { fichasMarkdown, Reconciler } from '../src/reconcile/index.ts';
import { buildDossier } from '../src/usl/dossier.ts';
import { reportHtml } from '../src/report/index.ts';
import { buildDecisionExportManifest } from '../src/decisions.ts';
import { compilePublicationPlan } from '../src/usl/publication-plan.ts';
import { loadSvp1Profiles, synthesizeCandidateContract } from '../src/svp1.ts';
import { resolveUniverseManifest } from '../src/registry/universes.ts';

const policy:RelationPolicy={policyVersion:'1.0',minimumDistinctKeys:2,minimumOverlapRatio:0.5};
function setup(options:{rows?:unknown[][];token?:string;observedAt?:string;mode?:'LOCAL'|'REPLAY'|'LIVE';origin?:'SYNTHETIC'|'PUBLIC';failSource?:string;truncated?:boolean;requestPrefix?:string;clockPrefix?:string;fingerprint?:string;universeId?:string;relationId?:string;toRows?:unknown[][]}={}){
  const universeId=options.universeId??'B4-'+randomUUID().slice(0,8),relationId=options.relationId??'relation-'+randomUUID().slice(0,8),relation={id:relationId,from:{db:'fixture',table:'left',column:'key'},to:{db:'fixture',table:'right',column:'key'},normalizationVersion:'exact-v1',normalizationLossless:true,normalizationAdapterCapability:'exact-text',reviewState:'REVIEWED' as const};
  const contract=legacyRelationContract(relation,universeId,'1.0','text',2),plan=planProbe(contract,{'fixture.left':['key'],'fixture.right':['key']},10);
  let calls=0;const adapter:ProbeAdapter={adapterId:'fake-reader',async read(request:ProbeReadRequest){calls++;if(request.sourceId.endsWith(':to')&&options.failSource)throw new SafeError('HTTP_ERROR',429,undefined,'17');return{tuples:((request.objectId.endsWith('right')?options.toRows:undefined)??options.rows??[['a'],['b']]).map(row=>[...row]),requestId:`${options.requestPrefix??'request'}-${calls}`,queryId:`query-${calls}`,requestedAt:`${options.clockPrefix??'2026-10-23T00:00:0'}${calls}${options.clockPrefix?'Z':''}`,observedAt:options.observedAt,nativeVersion:options.token?{state:'KNOWN',value:options.token}:{state:'UNKNOWN'},fingerprint:options.fingerprint?{state:'KNOWN',value:options.fingerprint,provenance:'verified-json2-bounded-typed-multiset'}:{state:'UNKNOWN'},statement:`SELECT key FROM ${request.objectId} LIMIT ${request.limit}`,truncated:options.truncated};}};
  return{universeId,relationId,contract,plan,adapter,calls:()=>calls,origin:options.origin??'SYNTHETIC',mode:options.mode??'LOCAL'};
}
async function capture(f:ReturnType<typeof setup>,checkedAt:string,token?:string,schemaFingerprints?:readonly SourceSchemaFingerprint[],recordedAt=checkedAt,selectedPolicy:RelationPolicy=policy){
  const adapter:ProbeAdapter=token?{adapterId:f.adapter.adapterId,read:async request=>{const result=await f.adapter.read(request);return{...result,nativeVersion:{state:'KNOWN',value:token}};}}:f.adapter;
  const execution=await executeProbe(f.plan,adapter,{runId:`capture-${randomUUID()}`,checkedAt,scope:'two bounded synthetic keys',executionMode:f.mode,dataOrigin:f.origin});
  const decision=evaluateRelation(f.contract,[execution.bundle],selectedPolicy);
  const record=recordFreshnessAttempt({universeId:f.universeId,relationId:f.relationId,contract:f.contract,evidence:execution.bundle,decision,policy:selectedPolicy,reads:execution.reads,errors:execution.errors,sourceSchemaFingerprints:schemaFingerprints,checkedAt,now:()=>recordedAt});
  return{record,execution,decision};
}

test('B4 identical native token revalidates despite new run, requests, and timestamps',async()=>{
  const f=setup({token:'source-v1',observedAt:'2026-10-22T20:00:00Z'}),first=await capture(f,'2026-10-23T00:00:00Z','source-v1'),second=await capture(f,'2026-10-23T00:01:00Z','source-v1');
  assert.equal(first.record.comparison,'FIRST_CHECK');assert.equal(second.record.comparison,'REVALIDATED');assert.equal(second.record.validity.observedAt,'2026-10-22T20:00:00Z');assert.notDeepEqual(first.record.sourceQueryHistory.map(q=>q.requestId),second.record.sourceQueryHistory.map(q=>q.requestId));
});

test('B4 bounded fingerprint excludes volatile metadata and documents its limits',async()=>{
  const f=setup({observedAt:'2026-10-22T20:00:00Z'}),first=await capture(f,'2026-10-23T00:00:00Z'),second=await capture(f,'2026-10-23T00:01:00Z');
  assert.equal(first.record.fingerprintScope,'BOUNDED_RESPONSE');assert.match(first.record.scopeDescription,/not global source identity or coverage/);assert.equal(first.record.validity.sourceToken,null);assert.equal(second.record.comparison,'REVALIDATED');
  const changed=setup({rows:[['a'],['c']],observedAt:'2026-10-22T20:00:00Z'});changed.universeId=f.universeId;changed.relationId=f.relationId;changed.contract=f.contract;changed.plan=f.plan;const changedRecord=await capture(changed,'2026-10-23T00:02:00Z');assert.equal(changedRecord.record.comparison,'CHANGED_REQUIRES_REVIEW');assert.equal(changedRecord.record.validity.requiresReview,true);
});

test('B4 bounded fingerprint ignores row and request ordering but preserves duplicate multiplicity',async()=>{
  const firstFixture=setup({rows:[['alpha'],['beta'],['alpha']],requestPrefix:'first',clockPrefix:'2026-10-23T00:00:0'});
  const first=await capture(firstFixture,'2026-10-23T00:00:00Z');
  const reorderedFixture=setup({rows:[['alpha'],['alpha'],['beta']],requestPrefix:'reordered',clockPrefix:'2026-10-24T00:00:0'});
  reorderedFixture.universeId=firstFixture.universeId;reorderedFixture.relationId=firstFixture.relationId;reorderedFixture.contract=firstFixture.contract;reorderedFixture.plan=firstFixture.plan;
  const reordered=await capture(reorderedFixture,'2026-10-23T00:01:00Z');
  assert.equal(reordered.record.comparison,'REVALIDATED');
  assert.notDeepEqual(first.record.sourceQueryHistory.map(item=>item.requestId),reordered.record.sourceQueryHistory.map(item=>item.requestId));
  assert.notDeepEqual(first.record.sourceQueryHistory.map(item=>item.requestedAt),reordered.record.sourceQueryHistory.map(item=>item.requestedAt));

  const reorderedEvidence=structuredClone(first.execution.bundle);
  reorderedEvidence.runRef.runId='capture-order-changed';reorderedEvidence.capturedAt='2026-10-25T00:00:00Z';
  reorderedEvidence.observations.reverse().forEach((observation,index)=>{observation.observationId=`capture-order-changed:${index}`;observation.requestId={state:'KNOWN',value:`replacement-request-${index}`};observation.checkedAt='2026-10-25T00:00:00Z';});
  const reorderedDecision=evaluateRelation(firstFixture.contract,[reorderedEvidence],policy);
  const reorderedObservationRecord=recordFreshnessAttempt({universeId:firstFixture.universeId,relationId:firstFixture.relationId,contract:firstFixture.contract,evidence:reorderedEvidence,decision:reorderedDecision,policy,reads:first.execution.reads.map((read,index)=>({...read,requestId:`replacement-request-${index}`,requestedAt:'2026-10-25T00:00:00Z'})),checkedAt:'2026-10-23T00:01:30Z',now:()=> '2026-10-23T00:01:30Z'});
  assert.equal(reorderedObservationRecord.comparison,'REVALIDATED');

  const duplicateFixture=setup({rows:[['alpha'],['beta'],['alpha'],['alpha']]});
  duplicateFixture.universeId=firstFixture.universeId;duplicateFixture.relationId=firstFixture.relationId;duplicateFixture.contract=firstFixture.contract;duplicateFixture.plan=firstFixture.plan;
  const duplicate=await capture(duplicateFixture,'2026-10-23T00:02:00Z');
  assert.equal(duplicate.record.comparison,'CHANGED_REQUIRES_REVIEW');
});

test('B4 verified typed bounded fingerprints participate when native source tokens are unavailable',async()=>{
  const firstFixture=setup({rows:[['01'],['1']],fingerprint:'typed-hash-v1'}),first=await capture(firstFixture,'2026-10-23T00:00:00Z');
  const changedFixture=setup({rows:[['01'],['1']],fingerprint:'typed-hash-v2'});changedFixture.universeId=firstFixture.universeId;changedFixture.relationId=firstFixture.relationId;changedFixture.contract=firstFixture.contract;changedFixture.plan=firstFixture.plan;
  const changed=await capture(changedFixture,'2026-10-23T00:01:00Z');
  assert.equal(first.record.fingerprintScope,'BOUNDED_RESPONSE');assert.equal(changed.record.comparison,'CHANGED_REQUIRES_REVIEW');
});

test('B4 source schema hash changes invalidate freshness when sampled tuples stay equal',async()=>{
  const f=setup(),fromSchema={sourceId:f.contract.from.sourceId,objectId:f.contract.from.objectId,state:'KNOWN' as const,sha256:'a'.repeat(64),provenance:'LEGACY_DESCRIBE_CAPTURE'},toSchema={sourceId:f.contract.to.sourceId,objectId:f.contract.to.objectId,state:'KNOWN' as const,sha256:'c'.repeat(64),provenance:'LEGACY_DESCRIBE_CAPTURE'};
  const first=await capture(f,'2026-10-23T00:00:00Z',undefined,[fromSchema,toSchema]);
  const changed=await capture(f,'2026-10-23T00:01:00Z',undefined,[{...fromSchema,sha256:'b'.repeat(64)},toSchema]);
  assert.deepEqual(first.record.evidence?.observations.map(item=>item.measuredTuples),changed.record.evidence?.observations.map(item=>item.measuredTuples));
  const firstSchema=first.record.schemaFingerprints.find(item=>item.sourceId===fromSchema.sourceId);assert.equal(firstSchema?.state==='KNOWN'?firstSchema.sha256:null,'a'.repeat(64));
  assert.equal(changed.record.comparison,'CHANGED_REQUIRES_REVIEW');
});

test('B4 monotonic per-relation sequence survives equal and backward clocks',async()=>{
  const f=setup({token:'same'}),first=await capture(f,'2026-10-23T00:00:00Z','same',undefined,'2026-10-23T00:00:00Z');
  const second=await capture(f,'2026-10-23T00:01:00Z','same',undefined,'2026-10-23T00:00:00Z');
  const third=await capture(f,'2026-10-23T00:02:00Z','same',undefined,'2025-01-01T00:00:00Z');
  const history=readFreshnessHistory(f.universeId,f.relationId);
  assert.deepEqual(history.map(item=>item.sequence),[1,2,3]);assert.equal(history[1].recordedAt,history[0].recordedAt);assert.equal(history[2].recordedAt,'2025-01-01T00:00:00Z');
  assert.equal(first.record.latestCompleteAttemptRef,first.record.attemptId);assert.equal(second.record.comparison,'REVALIDATED');assert.equal(third.record.latestCompleteAttemptRef,third.record.attemptId);
});

test('B4 native token, contract, and normalization changes require review',async()=>{
  const f=setup({token:'v1'});await capture(f,'2026-10-23T00:00:00Z','v1');
  const changedRowsSameToken=setup({rows:[['a'],['changed']],token:'v1'});changedRowsSameToken.universeId=f.universeId;changedRowsSameToken.relationId=f.relationId;changedRowsSameToken.contract=f.contract;changedRowsSameToken.plan=f.plan;const inconsistentToken=await capture(changedRowsSameToken,'2026-10-23T00:00:30Z','v1');assert.equal(inconsistentToken.record.comparison,'CHANGED_REQUIRES_REVIEW');
  const changedToken=await capture(f,'2026-10-23T00:01:00Z','v2');assert.equal(changedToken.record.comparison,'CHANGED_REQUIRES_REVIEW');
  const changedProvenance=setup({token:'v1',mode:'LIVE',origin:'PUBLIC'});changedProvenance.universeId=f.universeId;changedProvenance.relationId=f.relationId;changedProvenance.contract=f.contract;changedProvenance.plan=f.plan;const provenanceResult=await capture(changedProvenance,'2026-10-23T00:01:30Z','v1');assert.equal(provenanceResult.record.comparison,'CHANGED_REQUIRES_REVIEW');
  const changedContract=setup({token:'v2'});changedContract.universeId=f.universeId;changedContract.relationId=f.relationId;changedContract.contract={...f.contract,contractVersion:'1.1'};changedContract.plan=planProbe(changedContract.contract,{'fixture.left':['key'],'fixture.right':['key']},10);
  const contractResult=await capture(changedContract,'2026-10-23T00:02:00Z','v2');assert.equal(contractResult.record.comparison,'CHANGED_REQUIRES_REVIEW');
  changedContract.contract={...changedContract.contract,normalization:[{...changedContract.contract.normalization[0],version:{state:'KNOWN',value:'exact-v2'}}]};changedContract.plan=planProbe(changedContract.contract,{'fixture.left':['key'],'fixture.right':['key']},10);
  const normResult=await capture(changedContract,'2026-10-23T00:03:00Z','v2');assert.equal(normResult.record.comparison,'CHANGED_REQUIRES_REVIEW');
});

test('B4 timeout/429 and truncated attempts remain history and preserve the last complete ref',async()=>{
  const f=setup({token:'v1'}),complete=await capture(f,'2026-10-23T00:00:00Z','v1');
  const failing=setup({token:'v2',failSource:'to'});failing.universeId=f.universeId;failing.relationId=f.relationId;failing.contract=f.contract;failing.plan=f.plan;const partial=await capture(failing,'2026-10-23T00:01:00Z','v2');
  assert.equal(partial.record.comparison,'INCOMPLETE');assert.equal(partial.record.validity.completeness,'PARTIAL');assert.equal(partial.record.latestCompleteAttemptRef,complete.record.attemptId);assert.deepEqual(partial.record.transportFailures.map(item=>[item.http,item.retryAfter]),[[429,'17']]);
  const truncated=setup({token:'v3',truncated:true});truncated.universeId=f.universeId;truncated.relationId=f.relationId;truncated.contract=f.contract;truncated.plan=f.plan;const truncatedAttempt=await capture(truncated,'2026-10-23T00:02:00Z','v3');assert.equal(truncatedAttempt.record.comparison,'INCOMPLETE');assert.equal(truncatedAttempt.record.latestCompleteAttemptRef,complete.record.attemptId);
});

test('B4 history and replay are read-only, retain query references and preserve original mode/origin',async()=>{
  const f=setup({mode:'LOCAL',origin:'SYNTHETIC',token:'local-v1'}),captured=await capture(f,'2026-10-23T00:00:00Z','local-v1'),calls=f.calls();
  const history=readFreshnessHistory(f.universeId,f.relationId),replay=replayFreshnessAttempt(f.universeId,f.relationId,captured.record.attemptId);
  assert.equal(history.length,1);assert.equal(replay.executionMode,'REPLAY');assert.equal(replay.sourceExecutionMode,'LOCAL');assert.equal(replay.dataOrigin,'SYNTHETIC');assert.deepEqual(replay.sourceQueryHistory,captured.record.sourceQueryHistory);assert.equal(f.calls(),calls);assert.deepEqual(replay.decision,captured.decision);
  const other=setup({mode:'REPLAY',origin:'PUBLIC',token:'replay-v1'}),second=await capture(other,'2026-10-23T00:00:00Z','replay-v1');const replayed=replayFreshnessAttempt(other.universeId,other.relationId,second.record.attemptId);assert.equal(replayed.executionMode,'REPLAY');assert.equal(replayed.dataOrigin,'PUBLIC');
});

test('B4 TTL expiry is pending recheck and does not rewrite verdict or attempt history',async()=>{
  const f=setup({token:'v1'}),captured=await capture(f,'2026-10-23T00:00:00Z','v1'),before=readFreshnessHistory(f.universeId,f.relationId).length;
  const view=freshnessHistoryView(f.universeId,f.relationId,Date.parse('2026-10-23T00:00:10Z'),5000);
  assert.equal(view[0].displayStatus,'PENDING_RECHECK');assert.equal(view[0].decision?.verdict,captured.decision.verdict);assert.equal(readFreshnessHistory(f.universeId,f.relationId).length,before);
});

test('B4 failed live preflight remains an incomplete attempt without inventing a decision and retains latest complete',async()=>{
  const f=setup({token:'complete-v1'}),complete=await capture(f,'2026-10-23T00:00:00Z','complete-v1');
  const failed=recordFreshnessPreflightFailure({universeId:f.universeId,relationId:f.relationId,contract:f.contract,policy,sourceValidation:{status:'PARTIAL',tables:[{sourceId:f.contract.to.sourceId,logicalObjectId:f.contract.to.objectId,observedSchemaSha256:'d'.repeat(64),status:'ERROR',selectRequestId:'req-429',selectQueryId:'query-429',selectRequestedAt:'2026-10-23T00:01:00Z'}],failure:{sourceId:f.contract.to.sourceId,code:'RATE_LIMITED',http:429,retryAfter:'17'}},executionMode:'LIVE',dataOrigin:'SYNTHETIC',checkedAt:'2026-10-23T00:01:00Z'});
  assert.equal(failed.evidence,null);assert.equal(failed.decision,null);assert.equal(failed.latestCompleteAttemptRef,complete.record.attemptId);assert.equal(failed.sequence,complete.record.sequence+1);assert.equal(failed.schemaFingerprints.find(item=>item.sourceId===f.contract.to.sourceId)?.state,'KNOWN');assert.deepEqual(failed.sourceQueryHistory.map(item=>item.requestId),['req-429']);assert.equal(failed.transportFailures[0].retryAfter,'17');
  const replay=replayFreshnessAttempt(f.universeId,f.relationId,failed.attemptId);assert.equal(replay.status,'INCOMPLETE');assert.equal(replay.decision,null);assert.equal(replay.executionMode,'REPLAY');assert.equal(replay.sourceExecutionMode,'LIVE');
});

test('B4 CLI LOCAL revalidate, history, and replay use the real fixture route without env or network',()=>{
  const runId=`b4-cli-${randomUUID().slice(0,8)}`,env={...process.env,CONCORDIA_LOCAL_ENV_FILE:path.join(ROOT,'.concordia','no-such-local-env')};
  const run=execFileSync(process.execPath,['scripts/run-tsx.mjs','src/cli.ts','freshness','revalidate','--universe','GTFS','--relation','gtfs_trip_route','--mode','LOCAL','--run-id',runId],{cwd:ROOT,env,encoding:'utf8'});
  const attempt=readFreshnessHistory('concordia.universe.gtfs','gtfs_trip_route').at(-1)!;assert.ok(attempt.evidence);assert.equal(attempt.evidence.runRef.executionMode,'LOCAL');assert.equal(attempt.evidence.runRef.dataOrigin,'SYNTHETIC');assert.ok(run.includes('REVALIDATED'));
  const history=execFileSync(process.execPath,['scripts/run-tsx.mjs','src/cli.ts','freshness','history','--universe','GTFS','--relation','gtfs_trip_route'],{cwd:ROOT,env,encoding:'utf8'});assert.ok(history.includes(attempt.attemptId));
  const beforeReuse=readFreshnessHistory('concordia.universe.gtfs','gtfs_trip_route').length;const reused=execFileSync(process.execPath,['scripts/run-tsx.mjs','src/cli.ts','freshness','revalidate','--universe','GTFS','--relation','gtfs_trip_route','--mode','LOCAL','--run-id',runId],{cwd:ROOT,env,encoding:'utf8'});assert.ok(reused.includes('CAPTURE_REUSED'));assert.equal(readFreshnessHistory('concordia.universe.gtfs','gtfs_trip_route').length,beforeReuse);
  const replay=execFileSync(process.execPath,['scripts/run-tsx.mjs','src/cli.ts','freshness','replay','--universe','GTFS','--relation','gtfs_trip_route','--attempt',attempt.attemptId],{cwd:ROOT,env,encoding:'utf8'});assert.ok(replay.includes('"executionMode":"REPLAY"'));assert.ok(replay.includes('"dataOrigin":"SYNTHETIC"'));
});

test('B4 CLI LOCAL revalidate, history, and replay normalize GTFS_SVP1 candidate alias',()=>{
  const runId=`b4-svp1-cli-${randomUUID().slice(0,8)}`,env={...process.env,CONCORDIA_LOCAL_ENV_FILE:path.join(ROOT,'.concordia','no-such-local-env')};
  const scope='concordia.universe.gtfs-svp1',relationId='svp1_G01';
  const run=execFileSync(process.execPath,['scripts/run-tsx.mjs','src/cli.ts','freshness','revalidate','--universe','GTFS_SVP1','--relation','G01','--mode','LOCAL','--run-id',runId],{cwd:ROOT,env,encoding:'utf8'});
  const attempt=readFreshnessHistory(scope,relationId).at(-1)!;assert.ok(attempt.evidence);assert.equal(attempt.universeId,scope);assert.equal(attempt.relationId,relationId);assert.ok(run.includes('REVALIDATED'));
  const history=execFileSync(process.execPath,['scripts/run-tsx.mjs','src/cli.ts','freshness','history','--universe','GTFS_SVP1','--relation','G01'],{cwd:ROOT,env,encoding:'utf8'});assert.ok(history.includes(attempt.attemptId));assert.ok(history.includes('svp1_G01'));
  const replay=execFileSync(process.execPath,['scripts/run-tsx.mjs','src/cli.ts','freshness','replay','--universe','GTFS_SVP1','--relation','G01','--attempt',attempt.attemptId],{cwd:ROOT,env,encoding:'utf8'});assert.ok(replay.includes('"executionMode":"REPLAY"'));
});

test('B4 no-decision preflight failure is recorded under canonical candidate relation scope',()=>{
  const profile=loadSvp1Profiles().find(item=>item.manifestId==='concordia.universe.gtfs-svp1')!,requested='G01',relationId=resolveFreshnessRelationId(profile,requested),contract=synthesizeCandidateContract(profile.candidates.find(item=>item.candidateId===requested)!,profile)!;
  const failed=recordFreshnessPreflightFailure({universeId:resolveUniverseManifest('GTFS_SVP1')!.manifestId,relationId,contract,policy,sourceValidation:{status:'PARTIAL',tables:[],failure:{sourceId:'fixture:stopped',code:'FIXTURE_STOP'}},executionMode:'LIVE',dataOrigin:'SYNTHETIC',checkedAt:'2026-10-23T00:00:00Z'});
  assert.equal(failed.decision,null);assert.equal(failed.evidence,null);assert.equal(failed.relationId,'svp1_G01');assert.equal(readFreshnessHistory(failed.universeId,failed.relationId).at(-1)?.attemptId,failed.attemptId);
});
test('B4 rejects SVP1 controls and unsupported candidate ids before reads or environment loading',()=>{
  const profile=loadSvp1Profiles().find(item=>item.manifestId==='concordia.universe.gtfs-svp1')!,control=profile.candidates.find(item=>item.candidateId==='G06')!,unique=profile.candidates.find(item=>item.task==='UNIQUE_KEY')!;
  assert.equal(resolveFreshnessRelationId(profile,control.candidateId),`${control.baseRelationContractRef}:ablation:${control.candidateId}`);
  const base=profile.candidates.find(item=>item.candidateId==='G01')!,reordered={...profile,candidates:[control,base,...profile.candidates.filter(item=>item.candidateId!=='G06'&&item.candidateId!=='G01')]};
  assert.equal(resolveFreshnessRelationId(reordered,'G01'),'svp1_G01');assert.equal(resolveFreshnessRelationId(reordered,'svp1_G01'),'svp1_G01');assert.equal(resolveFreshnessRelationId(reordered,'G06'),'svp1_G01:ablation:G06');
  assert.throws(()=>assertFreshnessRelationSupported(profile,control.candidateId),/FRESHNESS_CONTROL_REVALIDATE_UNSUPPORTED/);
  assert.throws(()=>assertFreshnessRelationSupported(profile,unique.candidateId),/FRESHNESS_RELATION_UNSUPPORTED/);
  assert.throws(()=>assertFreshnessRelationSupported(profile,'UNKNOWN_CANDIDATE'),/FRESHNESS_RELATION_NOT_FOUND/);

  const env={...process.env,CONCORDIA_LOCAL_ENV_FILE:path.join(ROOT,'.concordia','must-not-load-env')},scope='concordia.universe.gtfs-svp1',baselineBefore=readFreshnessHistory(scope,'svp1_G01').length;
  const controlHistory=spawnSync(process.execPath,['scripts/run-tsx.mjs','src/cli.ts','freshness','history','--universe','GTFS_SVP1','--relation',control.candidateId],{cwd:ROOT,env,encoding:'utf8'});assert.equal(controlHistory.status,0);const controlHistoryBody=JSON.parse(controlHistory.stdout);assert.equal(controlHistoryBody.relationId,`${control.baseRelationContractRef}:ablation:${control.candidateId}`);assert.deepEqual(controlHistoryBody.attempts,[]);
  const run=(universe:string,relation:string)=>spawnSync(process.execPath,['scripts/run-tsx.mjs','src/cli.ts','freshness','revalidate','--universe',universe,'--relation',relation,'--mode','LIVE','--run-id',`scope-reject-${randomUUID().slice(0,8)}`],{cwd:ROOT,env,encoding:'utf8'});
  const controlResult=run('GTFS_SVP1_LIVE',control.candidateId);assert.notEqual(controlResult.status,0);assert.match(controlResult.stderr+controlResult.stdout,/FRESHNESS_CONTROL_REVALIDATE_UNSUPPORTED/);
  const uniqueResult=run('GTFS_SVP1_LIVE',unique.candidateId);assert.notEqual(uniqueResult.status,0);assert.match(uniqueResult.stderr+uniqueResult.stdout,/FRESHNESS_RELATION_UNSUPPORTED/);
  const unknownResult=run('GTFS_SVP1_LIVE','UNKNOWN_CANDIDATE');assert.notEqual(unknownResult.status,0);assert.match(unknownResult.stderr+unknownResult.stdout,/FRESHNESS_RELATION_NOT_FOUND/);
  for(const result of [controlResult,uniqueResult,unknownResult])assert.doesNotMatch(result.stderr+result.stdout,/ENV_FILE_MISSING/);
  assert.equal(readFreshnessHistory(scope,'svp1_G01').length,baselineBefore);
});
test('B5 reconciler ficha reload marks only dependent relation freshness without adding claims or ledger votes',async()=>{
  const f=setup({token:'consumer-v1'});f.contract={...f.contract,kind:'FOREIGN_KEY',identifierSpace:{state:'KNOWN',value:'fixture-key'}};const first=await capture(f,'2026-10-23T00:00:00Z','consumer-v1'),dir=path.join(ROOT,'.concordia',`b5-reconcile-${randomUUID()}`);let clockNow=Date.parse('2026-10-23T00:00:00Z');const freshnessOptions={now:()=>clockNow,maxAgeMs:24*60*60*1000};
  const reconciler=new Reconciler(f.universeId,dir);reconciler.addClaim({entity:`relation:${f.relationId}`,attribute:'status',value:first.decision.verdict,source:'fixture',confidence:.8,requestIds:['fixture-request'],sourceVersion:'v1',observedAt:'2026-10-23T00:00:00Z'});
  const initial=reconciler.fichas(undefined,freshnessOptions),claimsBefore=reconciler.claims.length,ledgerBefore=reconciler.hmem.ledger.all().length;
  assert.equal(initial.freshness.state,'CURRENT');assert.equal(initial.freshness.dependencies[0].attemptRef,first.record.attemptId);
  const unchanged=await capture(f,'2026-10-23T00:01:00Z','consumer-v1');clockNow=Date.parse('2026-10-23T00:01:00Z');const reloaded=new Reconciler(f.universeId,dir),replayedView=reloaded.fichas(initial.freshness,freshnessOptions);
  assert.equal(unchanged.record.semanticSourceVersion,first.record.semanticSourceVersion);assert.equal(replayedView.freshness.state,'CURRENT');assert.equal(reloaded.claims.length,claimsBefore);assert.equal(reloaded.hmem.ledger.all().length,ledgerBefore);
  const changed=setup({rows:[['a'],['c']]});changed.universeId=f.universeId;changed.relationId=f.relationId;changed.contract=f.contract;changed.plan=f.plan;const changedAttempt=await capture(changed,'2026-10-23T00:02:00Z');clockNow=Date.parse('2026-10-23T00:02:00Z');
  const staleView=new Reconciler(f.universeId,dir).fichas(initial.freshness,freshnessOptions);assert.equal(staleView.freshness.state,'STALE');assert.equal(staleView.freshness.dependencies[0].attemptRef,changedAttempt.record.attemptId);
  const policyFixture=setup({token:'policy-v1'}),policyFirst=await capture(policyFixture,'2026-10-23T00:02:00Z','policy-v1'),policyBaseline=consumerFreshnessSnapshot(policyFixture.universeId,[policyFixture.relationId],undefined,{now:()=>Date.parse('2026-10-23T00:02:00Z')});
  const policyChange=await capture(policyFixture,'2026-10-23T00:02:30Z','policy-v1',undefined,undefined,{...policy,policyVersion:'1.1'});clockNow=Date.parse('2026-10-23T00:02:30Z');const policyView=consumerFreshnessSnapshot(policyFixture.universeId,[policyFixture.relationId],policyBaseline,freshnessOptions),regenerated=consumerFreshnessSnapshot(policyFixture.universeId,[policyFixture.relationId],policyBaseline,{...freshnessOptions,mode:'REGENERATE'});
  assert.notEqual(policyChange.record.semanticSourceVersion,policyFirst.record.semanticSourceVersion);assert.equal(policyView.dependencies[0].state,'STALE');assert.equal(regenerated.dependencies[0].state,'CURRENT');assert.equal(regenerated.dependencies[0].policyVersion,'1.1');assert.equal(regenerated.dependencies[0].contractVersion,policyFixture.contract.contractVersion);assert.equal(regenerated.dependencies[0].decisionRef,policyChange.decision.decisionId);
  const beforeTtl=readFreshnessHistory(policyFixture.universeId,policyFixture.relationId),ttlView=consumerFreshnessSnapshot(policyFixture.universeId,[policyFixture.relationId],regenerated,{now:()=>Date.parse(policyChange.record.validity.checkedAt)+1001,maxAgeMs:1000}),afterTtl=readFreshnessHistory(policyFixture.universeId,policyFixture.relationId);
  assert.equal(ttlView.dependencies[0].state,'PENDING');assert.equal(beforeTtl.length,afterTtl.length);assert.equal(beforeTtl.at(-1)?.validity.checkedAt,afterTtl.at(-1)?.validity.checkedAt);
  const unrelated=consumerFreshnessSnapshot(f.universeId,[f.relationId,'unrelated-relation'],initial.freshness,freshnessOptions);assert.equal(unrelated.dependencies.find(item=>item.relationId==='unrelated-relation')?.state,'UNKNOWN');
  clockNow=Date.parse('2026-10-23T00:03:00Z');const pending=recordFreshnessPreflightFailure({universeId:f.universeId,relationId:f.relationId,contract:f.contract,policy,sourceValidation:{status:'PARTIAL',tables:[],failure:{sourceId:f.contract.to.sourceId,code:'RATE_LIMITED',http:429,retryAfter:'17'}},executionMode:'LIVE',dataOrigin:'SYNTHETIC',checkedAt:'2026-10-23T00:03:00Z'});
  const pendingView=new Reconciler(f.universeId,dir).fichas(staleView.freshness,freshnessOptions);assert.equal(pendingView.freshness.state,'PENDING');assert.equal(pendingView.freshness.dependencies[0].latestCompleteAttemptRef,changedAttempt.record.attemptId);assert.equal(pending.latestCompleteAttemptRef,changedAttempt.record.attemptId);
  assert.equal(new Reconciler(f.universeId,dir).claims.length,claimsBefore);assert.equal(new Reconciler(f.universeId,dir).hmem.ledger.all().length,ledgerBefore);
});
test('B5 canonical GTFS alias refreshes persisted consumers after evidence changes and explicit regeneration',async()=>{
  const f=setup({universeId:'concordia.universe.gtfs',relationId:'gtfs_trip_route',token:'gtfs-v1'});f.contract={...f.contract,kind:'FOREIGN_KEY',identifierSpace:{state:'KNOWN',value:'fixture-key'}};const first=await capture(f,'2026-10-23T00:00:00Z','gtfs-v1'),now=()=>Date.parse('2026-10-23T00:02:00Z');
  const savedV1=consumerFreshnessSnapshot('GTFS',['gtfs_trip_route'],undefined,{now:()=>Date.parse('2026-10-23T00:00:00Z')});assert.equal(savedV1.universeId,'concordia.universe.gtfs');assert.equal(savedV1.dependencies[0].attemptRef,first.record.attemptId);
  const changed=setup({rows:[['a'],['b']],toRows:[['c'],['d']],universeId:f.universeId,relationId:f.relationId});changed.contract=f.contract;changed.plan=f.plan;const second=await capture(changed,'2026-10-23T00:02:00Z');
  const stale=consumerFreshnessSnapshot('GTFS',['gtfs_trip_route'],savedV1,{now});assert.equal(stale.dependencies[0].state,'STALE');assert.equal(stale.dependencies[0].attemptRef,second.record.attemptId);
  const regenerated=consumerFreshnessSnapshot('GTFS',['gtfs_trip_route'],stale,{now,mode:'REGENERATE'});assert.equal(first.decision.verdict,'SOSTENIDA');assert.equal(second.decision.verdict,'ENGAÑOSA');assert.equal(regenerated.dependencies[0].state,'CURRENT');assert.notEqual(regenerated.dependencies[0].attemptRef,savedV1.dependencies[0].attemptRef);assert.equal(regenerated.dependencies[0].semanticSourceVersion,second.record.semanticSourceVersion);
  const persistedPath=path.join(ROOT,'.concordia',`b5-consumer-snapshot-${randomUUID()}.json`);fs.writeFileSync(persistedPath,JSON.stringify(regenerated));const reloadedSnapshot=JSON.parse(fs.readFileSync(persistedPath,'utf8')) as typeof regenerated;
  const renderedAfterReload=consumerFreshnessSnapshot('GTFS',['gtfs_trip_route'],reloadedSnapshot,{now});assert.equal(renderedAfterReload.dependencies[0].state,'CURRENT');assert.equal(renderedAfterReload.dependencies[0].attemptRef,second.record.attemptId);
  const staleV1=assessConsumerInputVersions(regenerated,[{relationId:f.relationId,verdict:first.decision.verdict,evidenceRefs:first.decision.evidenceBundleRefs,decisionRef:first.decision.decisionId,policyVersion:first.decision.policyVersion,contractVersion:f.contract.contractVersion}]);assert.equal(staleV1.dependencies[0].state,'STALE');const currentV2=assessConsumerInputVersions(regenerated,[{relationId:f.relationId,verdict:second.decision.verdict,evidenceRefs:second.decision.evidenceBundleRefs,decisionRef:second.decision.decisionId,policyVersion:second.decision.policyVersion,contractVersion:f.contract.contractVersion}]);assert.equal(currentV2.dependencies[0].state,'CURRENT');
  const dir=path.join(ROOT,'.concordia',`b5-gtfs-reconcile-${randomUUID()}`),reconciler=new Reconciler(f.universeId,dir);reconciler.addClaim({entity:`relation:${f.relationId}`,attribute:'status',value:'SOSTENIDA',source:'fixture',confidence:.8,requestIds:['gtfs-synthetic-request']});const fichas=reconciler.fichas(savedV1,{now,maxAgeMs:24*60*60*1000});assert.equal(fichas.freshness.dependencies[0].state,'STALE');
  const relation={relationId:f.relationId,from:{db:'GTFS',table:'trips',column:'route_id'},to:{db:'GTFS',table:'routes',column:'route_id'},verdict:'SOSTENIDA',rule:'synthetic_bounded_membership',evidenceId:'gtfs-evidence',evidence:{utc:'2026-10-23T00:00:00Z',status:'PASS',queries:[],overlap:{matched:2,probed:2,ratio:1},typeCompat:{castable:true},alerts:[]}};
  const cfg={relationBase:.5,relationOverlapWeight:.25,compatibleTypeWeight:.1},thresholds={minDistinctKeys:2,sustainedOverlap:.8},inventory={tables:{}};
  const dossier=buildDossier('GTFS',inventory,{utc:'2026-10-23T00:00:00Z',relations:[relation]},null,cfg,thresholds,[],null,stale);assert.equal(dossier.freshness?.state,'STALE');const regeneratedDossier=buildDossier('GTFS',inventory,{utc:'2026-10-23T00:02:00Z',relations:[relation]},null,cfg,thresholds,[],null,renderedAfterReload);assert.equal(regeneratedDossier.freshness?.state,'STALE');assert.match(regeneratedDossier.markdown,/decision:/);assert.match(fichasMarkdown({universe:'GTFS',fichas:[],freshness:renderedAfterReload}),/policy/);
  const html=reportHtml('GTFS',{sampleMode:true,mode:'offline',runId:'gtfs-synthetic'},{sourceUtc:'2026-10-23T00:00:00Z',artifacts:{discovery:inventory,relaciones:{relations:[relation]},dossier,fichas,eval:{},'usl-demo':{}},ledger:[],receipts:[]});assert.match(html,/STALE/);assert.match(html,/HISTORICAL SOSTENIDA/);assert.match(html,/Estado de frescura y dependencias/);
  const exportManifest=buildDecisionExportManifest('GTFS',true,renderedAfterReload,[],[],'2026-10-23T00:02:01Z',[{relationId:f.relationId,verdict:first.decision.verdict,evidenceRefs:first.decision.evidenceBundleRefs,decisionRef:first.decision.decisionId,policyVersion:first.decision.policyVersion,contractVersion:f.contract.contractVersion}]);assert.equal(exportManifest.status,'DRY_RUN');assert.equal(exportManifest.freshness.dependencies[0].attemptRef,second.record.attemptId);assert.equal(exportManifest.freshness.dependencies[0].state,'STALE');
  const currentPlan=compilePublicationPlan({universeId:f.universeId,contract:f.contract,evidence:[second.execution.bundle],decision:second.decision,target:{namespace:'fixture',model:'route_view'},freshnessSnapshot:renderedAfterReload});assert.equal(currentPlan.dependencyAssessment?.state,'CURRENT');const oldPlan=compilePublicationPlan({universeId:f.universeId,contract:f.contract,evidence:[first.execution.bundle],decision:first.decision,target:{namespace:'fixture',model:'route_view'},freshnessSnapshot:renderedAfterReload});assert.equal(oldPlan.dependencyAssessment?.state,'STALE');
  const stalePlan=compilePublicationPlan({universeId:f.universeId,contract:f.contract,evidence:[second.execution.bundle],decision:second.decision,target:{namespace:'fixture',model:'route_view'},freshnessSnapshot:stale});assert.equal(stalePlan.dependencyAssessment?.state,'STALE');
  const svp=setup({universeId:'concordia.universe.gtfs-svp1',relationId:'svp1_G01',token:'svp1-token'});svp.contract={...svp.contract,kind:'FOREIGN_KEY',identifierSpace:{state:'KNOWN',value:'fixture-key'}};const svpAttempt=await capture(svp,'2026-10-23T00:00:00Z','svp1-token');const svpAlias=consumerFreshnessSnapshot('GTFS_SVP1',['G01'],undefined,{now:()=>Date.parse('2026-10-23T00:00:00Z')});assert.equal(svpAlias.universeId,'concordia.universe.gtfs-svp1');assert.equal(svpAlias.dependencies[0].relationId,'svp1_G01');assert.equal(svpAlias.dependencies[0].attemptRef,svpAttempt.record.attemptId);
});