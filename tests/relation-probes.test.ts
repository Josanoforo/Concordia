import test from 'node:test';
import assert from 'node:assert/strict';
import type { RelationContract } from '../src/contracts/types.ts';
import { executeProbe, LocalFixtureAdapter, planProbe } from '../src/relations/probes.ts';
import { ZetarisProbeAdapter, zetarisTableSpecs } from '../src/relations/adapters/zetaris.ts';
import { SafeError } from '../src/runtime.ts';
import { evaluateRelation } from '../src/relations/decision.ts';

function compositeContract(): RelationContract {
  const known = (value: any) => ({ state: 'KNOWN' as const, value });
  return {
    schemaVersion: 1, id: 'composite-edge', contractVersion: '1.1',
    universeRef: { universeId: 'fixture', universeVersion: { state: 'UNKNOWN' }, namespace: known('local'), configFingerprint: { state: 'UNKNOWN' } },
    kind: 'FOREIGN_KEY', from: { sourceId: 's1', namespace: known('local'), objectId: 'left', orderedColumns: ['a', 'b'] },
    to: { sourceId: 's2', namespace: known('local'), objectId: 'right', orderedColumns: ['x', 'y'] }, identifierSpace: known('composite-key-space'),
    normalization: [0, 1].map(componentIndex => ({ componentIndex, operation: known('text'), version: known('1'), lossless: known(true), adapterCapability: known('tuple-text') })),
    semanticContext: { grain: { state: 'UNKNOWN' }, unit: { state: 'UNKNOWN' }, scale: { state: 'UNKNOWN' }, period: { state: 'UNKNOWN' }, timezone: { state: 'UNKNOWN' } },
    assertions: [], evidencePolicy: { requiredObservationTypes: ['KEY_MEMBERSHIP'], minimumCompleteness: 'COMPLETE_FOR_SCOPE', nulls: 'UNKNOWN', cardinality: 'UNKNOWN', declarationsAdmissible: 'UNKNOWN', minimumDistinctKeys: 'UNKNOWN' }, reviewState: 'REVIEWED'
  };
}

const allowlist = { left: ['a', 'b'], right: ['x', 'y'] };
const context = { runId: 'offline-A3-001', checkedAt: '2026-01-01T00:00:00Z', scope: 'synthetic fixture' };

test('A3 plans ordered composite projections with explicit allowlist and LIMIT', async () => {
  const contract = compositeContract();
  const plan = planProbe(contract, allowlist, 2);
  assert.equal(plan.limit, 2);
  assert.deepEqual(plan.endpoints.map(endpoint => endpoint.columns), [['a', 'b'], ['x', 'y']]);
  const adapter = new LocalFixtureAdapter({ 's1:left': [['01', 'north'], ['1', 'south']], 's2:right': [['01', 'north'], ['1', 'south']] });
  const result = await executeProbe(plan, adapter, context);
  assert.equal(result.status, 'COMPLETE');
  assert.deepEqual(result.bundle.observations[0].measuredTuples, [['01', 'north'], ['1', 'south']]);
  assert.equal(result.bundle.runRef.executionMode, 'LOCAL');
  assert.equal(result.bundle.runRef.dataOrigin, 'SYNTHETIC');
  assert.equal(result.bundle.contractVersion, contract.contractVersion);
});

test('A3 composite tuple identity is ordered and delimiter safe under the common evaluator', async () => {
  const contract = compositeContract();
  const plan = planProbe(contract, allowlist, 2);
  const safeRows = new LocalFixtureAdapter({ 's1:left': [['01', 'north'], ['1', 'south']], 's2:right': [['01', 'north'], ['1', 'south']] });
  const safe = await executeProbe(plan, safeRows, context);
  const supported = evaluateRelation(contract, [safe.bundle], { policyVersion: '1.1', minimumDistinctKeys: 2, minimumOverlapRatio: 1 });
  assert.equal(supported.verdict, 'SOSTENIDA');
  const collidingIfJoined = new LocalFixtureAdapter({ 's1:left': [['a|b', 'c'], ['x', 'y']], 's2:right': [['a', 'b|c'], ['x', 'y']] });
  const distinct = await executeProbe(plan, collidingIfJoined, context);
  const rejected = evaluateRelation(contract, [distinct.bundle], { policyVersion: '1.1', minimumDistinctKeys: 2, minimumOverlapRatio: 1 });
  assert.equal(rejected.verdict, 'ENGAÑOSA');
  assert.deepEqual(rejected.reasonCodes, ['observed_key_missing_from_referenced_sample']);
});
test('A3 evaluator resolves composite key values by declared projection positions', async () => {
  const contract=compositeContract();
  const base=await executeProbe(planProbe(contract,allowlist,2),new LocalFixtureAdapter({'s1:left':[['01','north'],['2','south']],'s2:right':[['01','north'],['2','south']]}),context);
  const reordered={...base.bundle,observations:[
    {...base.bundle.observations[0],projection:['left_label','b','a'],measuredTuples:[['source label','north','01'],['source label','south','2']]},
    {...base.bundle.observations[1],projection:['right_label','y','x'],measuredTuples:[['target label','north','01'],['target label','south','2']]}
  ]};
  const decision=evaluateRelation(contract,[reordered],{policyVersion:'1.1',minimumDistinctKeys:2,minimumOverlapRatio:1});
  assert.equal(decision.verdict,'SOSTENIDA');
});
test('A3 rejects an omitted or out-of-allowlist projection and invalid LIMIT before adapter use', () => {
  const contract = compositeContract();
  assert.throws(() => planProbe(contract, { left: ['a'] }, 2), /COLUMN_OUTSIDE_ALLOWLIST/);
  assert.throws(() => planProbe(contract, allowlist, 0), /INVALID_PROBE_LIMIT/);
  assert.throws(() => planProbe(contract, allowlist, 51), /INVALID_PROBE_LIMIT/);
});

test('L1 Zetaris probe adapter executes exactly the planned filtered reads and retains typed/raw evidence', async () => {
  const contract=compositeContract();
  contract.from.objectId='DB.left';contract.to.objectId='DB.right';
  const config={tables:{left:{db:'DB',physicalTable:'left_table',columns:[{name:'a'},{name:'b'},{name:'left_label'}]},right:{db:'DB',physicalTable:'right_table',columns:[{name:'x'},{name:'y'},{name:'right_label'}]}}};
  const allowed={'DB.left':['a','b','left_label'],'DB.right':['x','y','right_label']};
  const labels={'DB.left':['left_label'],'DB.right':['right_label']};
  const filters={'DB.left':{column:'a',values:['01']},'DB.right':{column:'x',values:['01']}};
  const calls:any[]=[];
  const client:any={runSql:async(sql:string,limit:number)=>{
    calls.push({sql,limit});const left=sql.includes('left_table');
    return {sql,requestId:left?'request-left':'request-right',queryId:left?'query-left':'query-right',utc:'2026-10-23T00:00:00Z',durationMs:3,rows:left?[['01','north','source label']]:[['01','north','target label']]};
  }};
  const plan=planProbe(contract,allowed,2,50,labels,filters);
  assert.deepEqual(plan.endpoints.map(endpoint=>endpoint.keyColumns),[['a','b'],['x','y']]);
  const adapter=new ZetarisProbeAdapter(zetarisTableSpecs(config),client);
  const result=await executeProbe(plan,adapter,{...context,runId:'fake-live-adapter',executionMode:'REPLAY',dataOrigin:'SYNTHETIC'});
  assert.equal(calls.length,2);
  assert.ok(calls.every(call=>call.sql.includes(' WHERE ')&&call.sql.includes(' LIMIT 2')));
  assert.equal(result.status,'COMPLETE');
  assert.deepEqual(result.bundle.observations[0].filters,['a IN (1 bounded values)']);
  assert.deepEqual(result.bundle.observations[0].measuredTuples,[['01','north','source label']]);
  assert.deepEqual(result.bundle.observations[0].observedAt,{state:'UNKNOWN'});
  assert.equal(result.reads[0].requestedAt,'2026-10-23T00:00:00Z');
  assert.equal(evaluateRelation(contract,[result.bundle],{policyVersion:'1.1',minimumDistinctKeys:1}).verdict,'SOSTENIDA');

  const partialClient:any={runSql:async(sql:string)=>{
    if(sql.includes('right_table'))throw new SafeError('FAKE_RATE_LIMIT',429,'redacted by executor','45');
    return {sql,requestId:'request-left',queryId:'query-left',utc:'2026-10-23T00:01:00Z',durationMs:3,rows:[['01','north','source label']]};
  }};
  const partial=await executeProbe(plan,new ZetarisProbeAdapter(zetarisTableSpecs(config),partialClient),{...context,runId:'fake-live-partial',executionMode:'REPLAY',dataOrigin:'SYNTHETIC'});
  assert.equal(partial.status,'PARTIAL');
  assert.equal(partial.reads.length,1);
  assert.equal(partial.bundle.observations[1].transportStatus,'ERROR');
  assert.deepEqual(partial.errors[0],{sourceRef:'s2',code:'ADAPTER_READ_FAILED',adapterCode:'FAKE_RATE_LIMIT',http:429,retryAfter:'45'});
  assert.deepEqual(partial.bundle.observations[0].requestId,{state:'KNOWN',value:'request-left'});
});
test('A3 caps adapter responses and marks evidence truncated', async () => {
  const plan = planProbe(compositeContract(), allowlist, 1);
  const result = await executeProbe(plan, new LocalFixtureAdapter({ 's1:left': [['a', '1'], ['b', '2']], 's2:right': [['a', '1'], ['b', '2']] }), context);
  assert.equal(result.status, 'TRUNCATED');
  assert.equal(result.bundle.completeness, 'TRUNCATED');
  assert.equal(result.bundle.observations[0].measuredTuples.length, 1);
  assert.equal(result.bundle.observations[0].truncated, true);
});

test('A3 preserves malformed or opaque values without normalizing away evidence', async () => {
  const plan = planProbe(compositeContract(), allowlist, 2);
  const result = await executeProbe(plan, new LocalFixtureAdapter({ 's1:left': [['not-a-number', '01'], ['1', '1']], 's2:right': [['not-a-number', '01'], ['1', '1']] }), context);
  assert.deepEqual(result.bundle.observations[0].measuredTuples, [['not-a-number', '01'], ['1', '1']]);
});

test('A3 preserves successful fragments and reports partial or total adapter errors', async () => {
  const plan = planProbe(compositeContract(), allowlist, 2);
  const partial = await executeProbe(plan, new LocalFixtureAdapter({ 's1:left': [['a', '1']] }), context);
  assert.equal(partial.status, 'PARTIAL');
  assert.equal(partial.bundle.completeness, 'PARTIAL');
  assert.equal(partial.bundle.observations[0].transportStatus, 'OK');
  assert.equal(partial.bundle.observations[1].transportStatus, 'ERROR');
  assert.equal(partial.bundle.observations[0].measuredTuples.length, 1);
  const failed = await executeProbe(plan, new LocalFixtureAdapter({}), context);
  assert.equal(failed.status, 'ERROR');
  assert.equal(failed.bundle.completeness, 'TRANSPORT_FAILED');
  assert.equal(failed.errors.length, 2);
});