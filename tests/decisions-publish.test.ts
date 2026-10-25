import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDecisionExportManifest, buildDecisionLedgerRows, decodeDecisionCsv, decisionReason, decisionTableSpecs, encodeDecisionCsv } from '../src/decisions.ts';

test('decision CSV preserves commas, quotes and multiline metadata on round trip',()=>{
  const csv=encodeDecisionCsv(['entity','source'],[['zone:1','catalog, "zones"\nsecond line']]);
  assert.deepEqual(decodeDecisionCsv(csv),[['entity','source'],['zone:1','catalog, "zones"\nsecond line']]);
});

test('decision exports include universe in all shared-table schemas',()=>{
  for(const columns of Object.values(decisionTableSpecs))assert.equal(columns[0],'universe');
  assert.deepEqual(decisionTableSpecs.concordia_ledger,['universe','id','entity','attribute','action','source','actor','utc']);
});

test('ledger export is deterministic and excludes claim values and state payloads',()=>{
  const claims=[{id:'memory-1',entity:'zone:1',attribute:'borough',source:'NY_TAXI.taxi_zones',value:'PRIVATE_CLAIM_VALUE'}];
  const ledger=[{memoryId:'memory-1',action:'update',timestamp:'2026-10-22T18:00:00.000Z',actor:'concordia',previousState:{content:'PRIVATE_OLD_CONTENT',value:'PRIVATE_OLD_VALUE'},newState:{content:'PRIVATE_NEW_CONTENT',value:'PRIVATE_NEW_VALUE'}}];
  const rows=buildDecisionLedgerRows('U1',ledger,claims),again=buildDecisionLedgerRows('U1',ledger,claims);
  assert.deepEqual(rows,again);
  const output=encodeDecisionCsv(decisionTableSpecs.concordia_ledger,rows);
  for(const secret of ['PRIVATE_CLAIM_VALUE','PRIVATE_OLD_CONTENT','PRIVATE_OLD_VALUE','PRIVATE_NEW_CONTENT','PRIVATE_NEW_VALUE'])assert.equal(output.includes(secret),false);
  assert.deepEqual(rows[0].slice(2,7),['zone:1','borough','update','NY_TAXI.taxi_zones','concordia']);
});

test('negative decision reason is a controlled code, never model prose',()=>{
  assert.equal(decisionReason({verdict:'INDETERMINADA',normalization:'text',explanation:'PRIVATE_COLUMN_VALUE'}),'unsafe_literal_key_format');
  assert.equal(decisionReason({verdict:'INDETERMINADA',rule:'thresholds_not_met',explanation:'PRIVATE_COLUMN_VALUE'}),'thresholds_not_met');
});

test('B5 dry-run decision export records current dependency refs and status',()=>{
  const freshness={schemaVersion:1 as const,universeId:'U-SYNTH',state:'CURRENT' as const,dependencies:[{relationId:'relation-1',state:'CURRENT' as const,semanticSourceVersion:'semantic-v1',contractVersion:'1.0',decisionRef:'decision-1',policyVersion:'1.1',verdict:'SOSTENIDA',evidenceRefs:['evidence-1'],attemptRef:'attempt-1',latestCompleteAttemptRef:'attempt-1',checkedAt:'2026-10-23T00:00:00Z'}]};
  const manifest=buildDecisionExportManifest('U-SYNTH',true,freshness,[],[], '2026-10-23T00:00:01Z');
  assert.equal(manifest.status,'DRY_RUN');assert.equal(manifest.freshness.dependencies[0].decisionRef,'decision-1');assert.equal(manifest.freshness.dependencies[0].policyVersion,'1.1');
});