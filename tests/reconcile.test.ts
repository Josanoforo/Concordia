import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Reconciler } from '../src/reconcile/index.ts';
import { ROOT } from '../src/runtime.ts';
test('same entity and field with equal confidence queues; correction persists and ledger only appends',()=>{
  const dir = fs.mkdtempSync(path.join(ROOT,'.concordia','reconcile-test-'));
  const r = new Reconciler('U1',dir,'fixture-review');
  for (const [source,value] of [['NY_TAXI.taxi_zones','Airport'],['NY_TAXI.zones','Unrelated']]) r.addClaim({entity:'zone:1',attribute:'name',value,source,confidence:.7,requestIds:['fixture-request']});
  r.detect(); assert.equal(r.conflicts.length,1); assert.equal(r.conflicts[0].status,'queued');
  const ledger = fs.readFileSync(path.join(dir,'ledger.jsonl'),'utf8');
  r.resolve(r.conflicts[0],r.claims[0].id,true,'synthetic test, not a production decision');
  assert.ok(fs.readFileSync(path.join(dir,'ledger.jsonl'),'utf8').startsWith(ledger));
  const reload = new Reconciler('U1',dir); assert.equal(reload.conflicts[0].status,'human_resolved');
  assert.equal(reload.hmem.store.get(reload.conflicts[0].correction!)?.provenance.origin,'user_correction');
  assert.ok(reload.reinject().correctionIds.length); assert.equal(reload.hmem.store.all().length,3);
});
test('same entity different attributes do not conflict; auto resolution requires evidence margin',()=>{
  const dir = fs.mkdtempSync(path.join(ROOT,'.concordia','reconcile-test-')); const r = new Reconciler('U1',dir);
  r.addClaim({entity:'zone:2',attribute:'name',value:'A',source:'fixture.a',confidence:.95,requestIds:['x']});
  r.addClaim({entity:'zone:2',attribute:'name',value:'B',source:'fixture.b',confidence:.5,requestIds:['y']});
  r.addClaim({entity:'zone:2',attribute:'borough',value:'C',source:'fixture.b',confidence:.5,requestIds:['z']});
  r.detect(); assert.equal(r.conflicts.length,1); assert.equal(r.conflicts[0].status,'auto_resolved');
  assert.ok(r.hmem.store.get(r.claims[1].id)?.supersededBy); assert.equal(r.hmem.store.all().length,3);
});

test('reinject preserves source/version/date/rule and alternatives without adding a support vote',()=>{
  const dir=fs.mkdtempSync(path.join(ROOT,'.concordia','reconcile-test-')),r=new Reconciler('U1',dir,'fixture-reuse');
  const shared={entity:'zone:3',attribute:'name',confidence:.7,requestIds:['request-a'],sourceVersion:'taxi-zones-v1',observedAt:'2026-10-22T10:00:00Z',rule:'bounded-label-join'};
  const original=r.addClaim({...shared,value:'Astoria',source:'NY_TAXI.taxi_zones'});
  const revisedObservation=r.addClaim({...shared,value:'Astoria',source:'NY_TAXI.taxi_zones',requestIds:['request-a-v2'],sourceVersion:'taxi-zones-v2',observedAt:'2026-10-22T11:00:00Z'});
  assert.equal(revisedObservation.id,original.id);
  assert.equal(original.observations?.length,2);
  r.addClaim({...shared,value:'Other place',source:'NY_TAXI.zones',requestIds:['request-b'],sourceVersion:'zones-v1'});
  r.detect();
  const before=r.claims.length,first=r.reinject(),second=r.reinject();
  assert.equal(r.claims.length,before);
  assert.equal(r.addClaim({...shared,value:'Astoria',source:'NY_TAXI.taxi_zones',requestIds:['request-a-v2'],sourceVersion:'taxi-zones-v2',observedAt:'2026-10-22T11:00:00Z'}).id,original.id);
  assert.equal(r.claims.length,before);
  assert.equal(first.alternatives[0].claims.length,2);
  assert.ok(first.context.includes('NY_TAXI.taxi_zones'));
  assert.deepEqual({sourceVersion:original.sourceVersion,observedAt:original.observedAt,rule:original.rule},{sourceVersion:'taxi-zones-v1',observedAt:'2026-10-22T10:00:00Z',rule:'bounded-label-join'});
  assert.deepEqual(original.observations?.map(o=>({sourceVersion:o.sourceVersion,observedAt:o.observedAt,requestIds:o.requestIds})),[{sourceVersion:'taxi-zones-v1',observedAt:'2026-10-22T10:00:00Z',requestIds:['request-a']},{sourceVersion:'taxi-zones-v2',observedAt:'2026-10-22T11:00:00Z',requestIds:['request-a-v2']}]);
  assert.equal(first.alternatives[0].claims.find((c:any)=>c.id===original.id)?.observations?.length,2);
  assert.deepEqual(second.alternatives,first.alternatives);
});
