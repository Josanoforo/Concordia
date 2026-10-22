import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompleteUsl } from '../src/usl/complete.ts';
import { readJson } from '../src/runtime.ts';
test('complete USL covers every sustained edge and only allowed source columns, including two targets for one key',()=>{
  // Public synthetic graph fixture keeps this compiler contract reproducible
  // without checking live evidence, request IDs, SQL, or source key values in.
  const baseline=readJson<any>('output_examples/sample-fixture/U1.json');
  const r=baseline.relations,plan=buildCompleteUsl('U1',r);
  assert.equal(plan.mappings.length,r.filter((r:any)=>r.verdict==='SOSTENIDA').length);
  assert.equal(plan.supportedIds.length,12);assert.equal(plan.plans.length,9);
  assert.ok(plan.mappings.some(m=>m.uslColumn.includes('__fk_')));
  assert.ok(!plan.plans.some(p=>p.name==='green_taxi'));
  assert.ok(plan.plans.find(p=>p.name==='taxi_zones')?.activation.includes("RLIKE '^-?[0-9]+([.]0+)?$'"));
  assert.ok(!plan.ddl.includes('customer_id'));
});
