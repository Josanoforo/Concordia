import test from 'node:test';
import assert from 'node:assert/strict';
import { criticize, evaluateTypedCounterprobe, judgeCounterprobe } from '../src/critic/adversarial.ts';
import { encodeDecisionCsv } from '../src/decisions.ts';
import { legacyRelationContract } from '../src/relations/legacy.ts';
import { evaluateRelation } from '../src/relations/decision.ts';
import { SafeError } from '../src/runtime.ts';
import type { EvidenceBundle, RelationContract } from '../src/contracts/types.ts';

const thresholds={criticOverlapFloor:0.8,criticLabelAgreementFloor:0.8};

test('bounded critic distinguishes duplicate keys, missing coverage and unavailable source',()=>{
  assert.equal(judgeCounterprobe({duplicateKeys:[{key:'1',rows:2}],seedKeys:1,matchedKeys:1,overlap:1},thresholds).status,'DEGRADED');
  assert.equal(judgeCounterprobe({seedKeys:2,matchedKeys:1,targetTruncated:true,overlap:0.5},thresholds).status,'INSUFFICIENT');
  assert.equal(judgeCounterprobe({seedKeys:1,matchedKeys:1,targetTruncated:true,overlap:1},thresholds).status,'INSUFFICIENT');
  assert.equal(judgeCounterprobe({seedKeys:1,matchedKeys:1,overlap:1,sourceError:{code:'HTTP_ERROR'}},thresholds).status,'INSUFFICIENT');
  assert.equal(judgeCounterprobe({seedKeys:0,matchedKeys:0,overlap:null,targetTruncated:false,sourceError:null},thresholds).status,'INSUFFICIENT');
});

const known = <T>(value:T) => ({state:'KNOWN' as const,value});
function typedContract(composite=false):RelationContract {
  const columns=composite?['tenant','key']:['key'];
  const contract=legacyRelationContract({id:'fixture-child-parent',from:{db:'fixture_db',table:'child',column:columns[0]},to:{db:'fixture_db',table:'parent',column:columns[0]},kind:'FOREIGN_KEY',identifierSpace:'customer-key',normalizationVersion:'1',normalizationLossless:true,normalizationAdapterCapability:'exact',reviewState:'REVIEWED'},'fixture-universe','1.0','text',1);
  contract.from.orderedColumns=[...columns];contract.to.orderedColumns=[...columns];
  contract.from.namespace=known('fixture-namespace');contract.to.namespace=known('fixture-namespace');
  contract.identifierSpace=known('customer-key');contract.reviewState='REVIEWED';
  contract.normalization=columns.map((_column,index)=>({componentIndex:index,operation:known('text'),version:known('1'),lossless:known(true),adapterCapability:known('exact-text')}));
  return contract;
}
function typedEvidence(contract:RelationContract,fromRows:unknown[][],toRows:unknown[][],runId:string,completeness:EvidenceBundle['completeness']='COMPLETE_FOR_SCOPE'):EvidenceBundle {
  const checkedAt='2026-10-23T21:00:00.000Z';
  const observation=(endpoint:RelationContract['from'],rows:unknown[][],side:string)=>({observationId:`${runId}:${side}`,type:'KEY_MEMBERSHIP',sourceRef:endpoint.sourceId,adapterId:'synthetic-critic',requestId:known(`${runId}:${side}`),observedAt:known(checkedAt),checkedAt,nativeVersion:{state:'UNKNOWN' as const},fingerprint:{state:'UNKNOWN' as const},projection:[...endpoint.orderedColumns],filters:[],limit:50,measuredTuples:rows.map(row=>[...row]),nullCount:rows.filter(row=>row.some(value=>value===null||value===undefined)).length,duplicateCount:'UNKNOWN' as const,truncated:false,transportStatus:'OK' as const,protectedPayloadRef:{state:'UNKNOWN' as const}});
  return {schemaVersion:1,evidenceBundleId:`evidence:${runId}`,relationRef:contract.id,contractVersion:contract.contractVersion,sourceRefs:[contract.from.sourceId,contract.to.sourceId].sort(),runRef:{runId,startedAt:{state:'UNKNOWN'},executionMode:'LOCAL',dataOrigin:'SYNTHETIC',configFingerprint:{state:'UNKNOWN'}},observations:[observation(contract.from,fromRows,'from'),observation(contract.to,toRows,'to')],scope:known('bounded synthetic fixture'),completeness,capturedAt:checkedAt};
}
const policy={policyVersion:'1.0',minimumDistinctKeys:1,minimumOverlapRatio:1};

test('typed critic treats new request IDs with identical tuples as repeated and preserves complete decision semantics',()=>{
  const contract=typedContract(),base=typedEvidence(contract,[['01'],['02']],[['01'],['02']],'base');
  const repeated=typedEvidence(contract,[['01'],['02']],[['01'],['02']],'same-tuples-new-request-ids');
  const result=evaluateTypedCounterprobe({contract,baseEvidence:base,counterEvidence:repeated,policy});
  assert.equal(result.status,'INSUFFICIENT');assert.equal(result.classification,'REPEATED');
  assert.equal(result.decision?.verdict,'SOSTENIDA');assert.deepEqual(result.decision?.evidenceBundleRefs,['evidence:same-tuples-new-request-ids']);
  const incomplete=typedEvidence(contract,[['03']],[['03']],'partial-new-tuples','PARTIAL');
  const partial=evaluateTypedCounterprobe({contract,baseEvidence:base,counterEvidence:incomplete,policy});
  assert.equal(partial.status,'INSUFFICIENT');assert.equal(partial.decision?.reasonCodes.includes('evidence_incomplete_or_truncated'),true);
  assert.equal(partial.evidence?.evidenceBundleId,'evidence:partial-new-tuples');
  const reusedIds=typedEvidence(contract,[['99']],[['99']],'base');
  const reused=evaluateTypedCounterprobe({contract,baseEvidence:base,counterEvidence:reusedIds,policy});
  assert.equal(reused.status,'INSUFFICIENT');assert.equal(reused.classification,'REPEATED');
  const nulls=evaluateTypedCounterprobe({contract,baseEvidence:typedEvidence(contract,[[null]],[[null]],'null-baseline'),counterEvidence:repeated,policy});
  assert.equal(nulls.status,'INSUFFICIENT');
  const zero=evaluateTypedCounterprobe({contract,baseEvidence:typedEvidence(contract,[],[],'zero-baseline'),counterEvidence:repeated,policy});
  assert.equal(zero.status,'INSUFFICIENT');
  const validBase=typedEvidence(contract,[['01']],[['01']],'valid-for-empty-counter');
  assert.equal(evaluateTypedCounterprobe({contract,baseEvidence:validBase,counterEvidence:typedEvidence(contract,[[null]],[[null]],'null-counter'),policy}).status,'INSUFFICIENT');
  assert.equal(evaluateTypedCounterprobe({contract,baseEvidence:validBase,counterEvidence:typedEvidence(contract,[],[],'zero-counter'),policy}).status,'INSUFFICIENT');
});

test('typed critic reports novel support or common-engine counterexample without scalarizing composite tuples',()=>{
  const contract=typedContract(),base=typedEvidence(contract,[['01'],['02']],[['01'],['02']],'base-for-novelty');
  const support=evaluateTypedCounterprobe({contract,baseEvidence:base,counterEvidence:typedEvidence(contract,[['03']],[['03']],'new-support'),policy});
  assert.equal(support.status,'CONFIRMED');assert.equal(support.decision?.verdict,'SOSTENIDA');assert.equal(support.decision?.requiresReview,true);
  const contradiction=evaluateTypedCounterprobe({contract,baseEvidence:base,counterEvidence:typedEvidence(contract,[['03']],[['02']],'new-counterexample'),policy});
  assert.equal(contradiction.status,'DEGRADED');assert.equal(contradiction.decision?.verdict,'ENGAÑOSA');assert.equal(contradiction.decision?.requiresReview,true);
  const removedTarget=evaluateTypedCounterprobe({contract,baseEvidence:base,counterEvidence:typedEvidence(contract,[['01'],['02']],[['01']],'removed-known-target'),policy});
  assert.equal(removedTarget.status,'DEGRADED');assert.equal(removedTarget.classification,'COUNTEREXAMPLE');assert.equal(removedTarget.novelty?.newSourceTuples,0);assert.equal(removedTarget.novelty?.newTargetTuples,0);
  const composite=typedContract(true),compositeBase=typedEvidence(composite,[['tenant-1','01']],[['tenant-1','01']],'composite-base');
  const compositeCounter=typedEvidence(composite,[['tenant-1','1']],[['tenant-1','01']],'composite-counter');
  const compositeResult=evaluateTypedCounterprobe({contract:composite,baseEvidence:compositeBase,counterEvidence:compositeCounter,policy});
  assert.equal(compositeResult.status,'DEGRADED');assert.equal(compositeResult.decision?.verdict,'ENGAÑOSA');
  const integer=typedContract();integer.normalization[0].operation=known('integer');
  const integerBase=typedEvidence(integer,[['01']],[['01']],'integer-base');
  const integerCounter=typedEvidence(integer,[['1']],[['1']],'integer-counter');
  const integerResult=evaluateTypedCounterprobe({contract:integer,baseEvidence:integerBase,counterEvidence:integerCounter,policy});
  assert.equal(integerResult.status,'INSUFFICIENT');assert.equal(integerResult.classification,'REPEATED');
});

test('public criticize uses fake transport, persists common Decision references and keeps latest complete on repetition',async()=>{
  const contract=typedContract(),base=typedEvidence(contract,[['01'],['02']],[['01'],['02']],'public-baseline');
  const baseDecision=evaluateRelation(contract,[base],policy);
  const relation:any={relationId:contract.id,from:{table:'child',column:'key'},to:{table:'parent',column:'key'},verdict:'SOSTENIDA',decision:baseDecision,relationContract:contract,evidence:{typedEvidence:base}};
  let relations:any={relations:[relation]};
  const config={database:'fixture_db',costExclusions:{U1:[]},tables:{child:{columns:[{name:'key',type:'string'}]},parent:{columns:[{name:'key',type:'string'}]}}};
  const inventory={tables:{child:{labels:[]},parent:{labels:[]}}};
  const thresholds={relationPolicyVersion:'1.0',minDistinctKeys:1,sustainedOverlap:1,criticProbeLimit:10};
  let sourceRound=0,clock=0;const sqlCalls:string[]=[];let persisted:any;
  const client={async runSql(sql:string){sqlCalls.push(sql);if(sql.includes('NOT IN')){sourceRound++;if(sourceRound===3)throw new SafeError('HTTP_ERROR',429);return {sql,requestId:`source-request-${sourceRound}`,queryId:`source-query-${sourceRound}`,rows:[['03']],durationMs:0,utc:`2026-10-23T21:0${sourceRound}:00.000Z`};}return {sql,requestId:`target-request-${sourceRound}`,queryId:`target-query-${sourceRound}`,rows:[['03']],durationMs:0,utc:`2026-10-23T21:0${sourceRound}:30.000Z`};}};
  const dependencies={relations,config,inventory,thresholds,client,persist:false,executionMode:'LOCAL' as const,dataOrigin:'SYNTHETIC' as const,now:()=>`2026-10-23T21:0${clock++}:00.000Z`,persistRelations:(_id:string,value:any)=>{persisted=structuredClone(value);}};
  const first=await criticize('U1',{},dependencies);
  assert.equal(first.results[0].status,'CONFIRMED');assert.equal(sqlCalls.length,2);
  assert.equal(sqlCalls.some(sql=>/CAST|TRIM/i.test(sql)),false);assert.equal(sqlCalls.every(sql=>/LIMIT 10/.test(sql)),true);
  assert.equal(relation.verdict,'SOSTENIDA');assert.equal(relation.decision.decisionId,relation.criticDecision.decisionId);
  assert.equal(relation.criticDecision.verdict,'SOSTENIDA');assert.equal(relation.critic.history[0].baseEvidenceRef,base.evidenceBundleId);
  assert.equal(relation.critic.history[0].evidenceBundleRef,relation.criticDecision.evidenceBundleRefs[0]);
  assert.equal(relation.criticEvidence.evidenceBundleId,relation.critic.lastCompleteEvidenceRef);
  assert.equal(persisted.relations[0].criticDecision.decisionId,relation.criticDecision.decisionId);
  const latestComplete=relation.criticDecision.decisionId;
  relations=JSON.parse(JSON.stringify(relations));dependencies.relations=relations;
  const reloadedRelation=relations.relations[0];
  const second=await criticize('U1',{force:true},dependencies);
  assert.equal(second.results[0].status,'INSUFFICIENT');assert.equal(second.results[0].classification,'REPEATED');
  assert.equal(reloadedRelation.criticDecision.decisionId,latestComplete);assert.equal(reloadedRelation.critic.history.length,2);assert.equal(sqlCalls.length,4);
  assert.equal(second.results[0].baseEvidenceRef,base.evidenceBundleId);
  assert.deepEqual(reloadedRelation.critic.history[1].baseDecisionSnapshot.evidenceBundleRefs,[base.evidenceBundleId]);
  assert.equal(second.results[0].baseDecisionRef,reloadedRelation.critic.history[1].baseDecisionSnapshot.decisionId);
  const third=await criticize('U1',{force:true},dependencies);
  assert.equal(third.results[0].status,'ERROR');assert.equal(third.results[0].transportFailures.length,1);assert.equal(third.results[0].transportFailures[0].http,429);assert.equal(reloadedRelation.criticDecision.decisionId,latestComplete);
  assert.equal(reloadedRelation.critic.lastCompleteEvidenceRef,reloadedRelation.criticEvidence.evidenceBundleId);
});

test('public critic leaves degraded common Decision authoritative and skips excluded or stale relations before transport',async()=>{
  const contract=typedContract(),base=typedEvidence(contract,[['01'],['02']],[['01'],['02']],'public-degrade-base');
  const baseDecision=evaluateRelation(contract,[base],policy);
  const degradedRelation:any={relationId:contract.id,from:{table:'child',column:'key'},to:{table:'parent',column:'key'},verdict:'SOSTENIDA',decision:baseDecision,relationContract:contract,evidence:{typedEvidence:base}};
  const excluded={...degradedRelation,relationId:'excluded-hvv',from:{table:'hvv',column:'key'}};
  const stale={...degradedRelation,relationId:'stale-relation',freshness:{state:'DEGRADADA'}};
  const staleDecision=baseDecision;
  const staleContract=typedContract();staleContract.id='stale-relation';
  const staleEvidence=typedEvidence(staleContract,[['01']],[['01']],'stale-base');
  stale.relationContract=staleContract;stale.evidence={typedEvidence:staleEvidence};stale.decision=evaluateRelation(staleContract,[staleEvidence],policy);
  let calls=0;
  const noReadClient={async runSql(){calls++;throw new Error('unexpected transport read');}};
  const skipSummary=await criticize('U1',{force:true},{relations:{relations:[excluded,stale]},config:{database:'fixture_db',costExclusions:{U1:['hvv']},tables:{child:{columns:[{name:'key',type:'string'}]},parent:{columns:[{name:'key',type:'string'}]},hvv:{columns:[{name:'key',type:'string'}]}}},inventory:{tables:{}},thresholds:{relationPolicyVersion:'1.0',minDistinctKeys:1,sustainedOverlap:1},client:noReadClient,persist:false,executionMode:'LOCAL',dataOrigin:'SYNTHETIC'});
  assert.equal(calls,0);assert.deepEqual(skipSummary.results.map((item:any)=>item.status),['SKIPPED','INSUFFICIENT']);
  assert.equal(stale.decision.verdict,'SOSTENIDA');assert.equal(stale.critic.reason.includes('no source reads issued'),true);

  const degradedConfig={database:'fixture_db',costExclusions:{U1:[]},tables:{child:{columns:[{name:'key',type:'string'}]},parent:{columns:[{name:'key',type:'string'}]}}};
  let sourceDone=false;
  const mismatchClient={async runSql(sql:string){if(sql.includes('NOT IN')){sourceDone=true;return {sql,requestId:'novel-source',queryId:'novel-source-query',rows:[['03']],durationMs:0,utc:'2026-10-23T21:03:00.000Z'};}return {sql,requestId:'mismatch-target',queryId:'mismatch-target-query',rows:[['02']],durationMs:0,utc:'2026-10-23T21:03:30.000Z'};}};
  let persisted:any;
  const result=await criticize('U1',{force:true},{relations:{relations:[degradedRelation]},config:degradedConfig,inventory:{tables:{child:{labels:[]},parent:{labels:[]}}},thresholds:{relationPolicyVersion:'1.0',minDistinctKeys:1,sustainedOverlap:1,criticProbeLimit:10},client:mismatchClient,persist:false,executionMode:'LOCAL',dataOrigin:'SYNTHETIC',persistRelations:(_id:string,value:any)=>{persisted=structuredClone(value);}});
  assert.equal(sourceDone,true);assert.equal(result.results[0].status,'DEGRADED');
  const output=persisted.relations[0];
  assert.equal(output.verdict,'ENGAÑOSA');assert.equal(output.decision.verdict,'ENGAÑOSA');assert.equal(output.decision.requiresReview,true);
  assert.equal(output.criticDecision.decisionId,output.decision.decisionId);assert.equal(output.evidence.typedEvidence.evidenceBundleId,base.evidenceBundleId);
  assert.equal(output.critic.history[0].baseDecisionSnapshot.decisionId,baseDecision.decisionId);
  assert.equal(output.criticEvidence.evidenceBundleId,output.critic.lastCompleteEvidenceRef);
});

test('decision CSV quotes delimiters and line breaks without losing metadata',()=>{
  const serialized=encodeDecisionCsv(['entity','source'],[['zone:1','SEC_DATA,table\nrow']]);
  assert.equal(serialized,'"entity","source"\r\n"zone:1","SEC_DATA,table\nrow"\r\n');
});
