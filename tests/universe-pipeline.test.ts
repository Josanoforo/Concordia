import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeKey, probeUniverse, sourceQuery, universeConfig } from '../src/universe-pipeline.ts';
import { probe as probeU1 } from '../src/probe/index.ts';
import { SafeError } from '../src/runtime.ts';
import { readJson } from '../src/runtime.ts';
import { readFreshnessHistory } from '../src/reconcile/freshness-history.ts';
test('CIK text remains distinct while explicit integer normalization removes padding without precision loss',()=>{
  const contract=readJson<any>('universes/U2_companies.json').normalizationContract;
  assert.notEqual(normalizeKey('0000320193','text',contract),normalizeKey(320193,'text',contract));
  assert.equal(normalizeKey('0000320193','integer-pad10',contract),normalizeKey(320193,'integer-pad10',contract));
  assert.equal(normalizeKey('9007199254740993123','integer',contract),'9007199254740993123');
  assert.notEqual(normalizeKey('  ACME','text',contract),normalizeKey('ACME','text',contract));
  assert.throws(()=>normalizeKey('1','integer',{}));
  assert.throws(()=>sourceQuery({baseSql:'SELECT * FROM private'}));
});

test('U1 probe producer retains successful rows and sanitized 429 diagnostics without persistence',async()=>{
  const candidate:any={id:'taxi_zones.LocationID__zones.zone_id',from:{db:'NY_TAXI',table:'taxi_zones',column:'LocationID'},to:{db:'NY_TAXI',table:'zones',column:'zone_id'},reason:[],proposedBy:'heuristic',confidence:0.7};
  const table=(columns:string[],rows:any[][],labels:string[],role:string,keyColumns:string[])=>({columns,schema:columns.map(name=>({name,type:'string'})),sample:{rows,utc:'2026-10-23T00:00:00.000Z'},labels,role,keyColumns});
  const inventory:any={candidates:[candidate],tables:{taxi_zones:table(['LocationID','zone','borough'],[['1','Manhattan','Manhattan']],['zone','borough'],'dimension',['LocationID']),zones:table(['zone_id','zone_name','borough'],[['1','Manhattan','Manhattan']],['zone_name','borough'],'dimension',['zone_id'])}};
  const client:any={runSql:async(sql:string)=>{if(sql.includes('FROM NY_TAXI.zones'))throw new SafeError('FAKE_RATE_LIMIT',429,'redacted','45');return {sql,requestId:'u1-success',queryId:'u1-query',rows:[['1','Manhattan','Manhattan']],durationMs:2,utc:'2026-10-23T00:00:00.000Z'};}};
  const [result]=await probeU1({candidateIds:[candidate.id]},{inventory,client,persist:false});
  assert.equal(result.status,'INCOMPLETE');
  assert.deepEqual(result.queries.map(query=>query.requestId),['u1-success']);
  assert.equal(result.typedEvidence!.observations[0].transportStatus,'OK');
  assert.equal(result.typedEvidence!.observations[0].measuredTuples[0][0],'1');
  assert.equal(result.typedEvidence!.observations[1].transportStatus,'ERROR');
  assert.equal((result.error as any).failedSources[0].http,429);
  assert.equal((result.error as any).failedSources[0].retryAfter,'45');
  const recorded=await probeU1({candidateIds:[candidate.id]},{inventory,client,persist:false,recordFreshness:true,now:()=> '2026-10-23T00:02:00Z'});
  const attempt=readFreshnessHistory('concordia.universe.ny-taxi',candidate.id).at(-1)!;
  assert.equal(attempt.evidence?.contractVersion,recorded[0].typedEvidence?.contractVersion);assert.equal(attempt.decision?.relationRef,recorded[0].relationContract?.id);assert.equal(attempt.validity.completeness,'PARTIAL');assert.equal(attempt.schemaFingerprints.find(item=>item.sourceId===recorded[0].relationContract?.from.sourceId)?.state,'KNOWN');
});

test('U2 config-driven producer retains partial 429 evidence without persistence',async()=>{
  const cfg=universeConfig('U2');
  const sampleValues:Record<string,unknown[]>={apple_revenue_facts:['320193'],apple_submissions_raw:['0000320193','0111'],sic_reference:['0111','technology']};
  const tables=Object.fromEntries(Object.entries<any>(cfg.tables).map(([name,spec])=>[name,{columns:spec.columns.map((column:any)=>column.name),schema:spec.columns,sample:{rows:[spec.columns.map((column:any,index:number)=>sampleValues[name]?.[index]??'fixture')]},labels:spec.labels??[],keyColumns:spec.keyColumns??[],role:spec.role??'dimension'}]));
  let calls=0;
  const client:any={runSql:async(sql:string)=>{calls++;if(calls===2)throw new SafeError('FAKE_RATE_LIMIT',429,'redacted','45');const table=sql.includes('apple_revenue_facts')?'apple_revenue_facts':sql.includes('apple_submissions_raw')?'apple_submissions_raw':'sic_codes_v4_raw';const rows=table==='apple_revenue_facts'?[['320193']]:table==='apple_submissions_raw'?[['0000320193','0111']]:[['0111','technology']];return {sql,requestId:`u2-${calls}`,queryId:`u2-q-${calls}`,rows,durationMs:2,utc:'2026-10-23T00:00:00.000Z'};}};
  const result=await probeUniverse('U2',{inventory:{tables},client,persist:false,recordFreshness:true,now:()=> '2026-10-23T00:02:00Z'});
  const first=result.relations.find((relation:any)=>relation.relationId==='cik_text_trap')!.evidence;
  assert.equal(first.status,'INCOMPLETE');
  assert.deepEqual(first.queries.map((query:any)=>query.requestId),['u2-1']);
  assert.equal(first.typedEvidence.observations[0].transportStatus,'OK');
  assert.equal(first.typedEvidence.observations[0].measuredTuples[0][0],'320193');
  assert.equal(first.typedEvidence.observations[1].transportStatus,'ERROR');
  assert.equal(first.error.failedSources[0].http,429);
  assert.equal(first.error.failedSources[0].retryAfter,'45');
  const attempt=readFreshnessHistory('concordia.universe.sec-companies','cik_text_trap').at(-1)!;
  assert.equal(attempt.evidence?.contractVersion,first.typedEvidence.contractVersion);assert.equal(attempt.decision?.relationRef,first.relationContract.id);assert.equal(attempt.validity.completeness,'PARTIAL');assert.ok(attempt.schemaFingerprints.every(item=>item.state==='UNKNOWN'));
});
