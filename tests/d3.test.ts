import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mappingMetrics, predictColumn } from '../src/madi.ts';
import { demo, optionalNightshift, requireZetaris } from '../src/demo.ts';
import { demoUsl, verificationTable } from '../src/usl/demo.ts';
import { buildCompleteUsl } from '../src/usl/complete.ts';
import { escapeHtml, reportHtml } from '../src/report/index.ts';
import { loadCache, isolateTrace, snapshotLabel } from '../src/demo-cache.ts';
import { readJson, ROOT, SafeError, traceFileForRun } from '../src/runtime.ts';

test('U3 eval counts actual correspondence tuples, deduplicates, preserves FP/FN and undefined denominators',()=>{
  const a={source_dataset:'synthetic_source',source_column:'company',target_dataset:'target_schema',target_column:'name'};
  const b={...a,source_column:'annual_amount',target_column:'assets'},wrong={...a,source_column:'country'};
  const m=mappingMetrics([a,a,wrong],[a,b]);
  assert.equal(m.truePositives,1);assert.equal(m.precision,.5);assert.equal(m.recall,.5);
  assert.deepEqual(m.falsePositives,[wrong]);assert.deepEqual(m.falseNegatives,[b]);
  assert.equal(mappingMetrics([],[]).precision,null);assert.equal(mappingMetrics([],[]).recall,null);
  assert.equal(mappingMetrics([],[a]).recall,0);
});
test('metadata heuristic abstains for opaque or ambiguous fields and never equates income and revenue',()=>{
  const patterns={name:'\\bname\\b',country:'\\bcountry\\b',revenue:'\\b(revenue|sales)\\b'};
  assert.equal(predictColumn('org_name','company name',patterns,Object.keys(patterns)).target,'name');
  assert.equal(predictColumn('Attribute_1','First source attribute',patterns,Object.keys(patterns)).target,null);
  assert.equal(predictColumn('country_name','country name',patterns,Object.keys(patterns)).target,null);
  assert.equal(predictColumn('annual_income','Annual income',patterns,Object.keys(patterns)).target,null);
});
test('partial Nightshift failure falls back without retry or fabricated receipt',async()=>{
  let calls=0;const result=await optionalNightshift(async()=>{calls++;throw new SafeError('NETWORK_ERROR');});
  assert.equal(calls,1);assert.equal(result.status,'DETERMINISTIC_FALLBACK');assert.ok(!('receipt' in result));
});
test('Zetaris failure stops before downstream stages without retry or simulated evidence',async()=>{
  let calls=0;
  await assert.rejects(requireZetaris(async()=>{calls++;throw new SafeError('NETWORK_ERROR');}),/ZETARIS_UNAVAILABLE_STOP_NO_SIMULATED_PROBES/);
  assert.equal(calls,1);
});
test('USL live verification selects configured tables and fails closed if missing',()=>{
  const fixture=readJson<any>('output_examples/sample-fixture/U1.json');
  const plan=buildCompleteUsl('U1',fixture.relations);
  assert.equal(verificationTable('U1',plan.plans).name,'zones');
  assert.throws(()=>verificationTable('U1',[{name:'trips'}]),{code:'USL_VERIFICATION_TABLE_MISSING'});
  assert.throws(()=>verificationTable('U3',[]),{code:'USL_UNIVERSE_NOT_AUTHORIZED'});
});

const stubClient=(fn:any)=>({runSql:fn,runLegacyMutationSql:fn}) as any; // explicit legacy method on the simulated client: demo.ts has no runSql fallback
test('existing U1 USL verifies the configured zones view without compiling or activating',async(t)=>{
  const fixture=readJson<any>('output_examples/sample-fixture/U1.json'),plan=buildCompleteUsl('U1',fixture.relations);
  const relationsPath=path.join(ROOT,'out/U1/relaciones.json'),previous=fs.existsSync(relationsPath)?fs.readFileSync(relationsPath):null;
  fs.mkdirSync(path.dirname(relationsPath),{recursive:true});fs.writeFileSync(relationsPath,JSON.stringify({relations:fixture.relations}));
  t.after(()=>{if(previous!==null)fs.writeFileSync(relationsPath,previous);else fs.rmSync(relationsPath,{force:true});});
  const sent:string[]=[],response=(sql:string,rows:any[][])=>({sql,rows,utc:'2026-01-01',requestId:'synthetic',queryId:'synthetic',durationMs:1});
  const reused=await demoUsl('U1',stubClient(async(sql:string)=>{
    sent.push(sql);
    const rows=sql.startsWith('LOAD')?[[JSON.stringify({tables:plan.plans.map(p=>({name:p.name}))})]]:[['synthetic']];
    return response(sql,rows);
  }));
  assert.equal(reused.status,'REUSED_EXISTING');assert.equal(reused.verifiedNow,'zones');assert.equal(reused.modelDetails.tables.length,plan.plans.length);
  assert.match(sent[1],/FROM lightning\.metastore\.concordia_u1\.u1_usl\.zones LIMIT 3/);assert.ok(sent.every(sql=>!/COMPILE|UPDATE|ACTIVATE/.test(sql)));
});

test('existing USL is reused; absent models alone authorize deployment; network/ambiguous errors never do',async(t)=>{
  const relations=[
    {relationId:'fixture:company:cik',verdict:'SOSTENIDA',from:{db:'SEC_DATA',table:'apple_revenue_facts',column:'cik'},to:{db:'SEC_DATA',table:'apple_submissions_raw',column:'cik'},explanation:'synthetic fixture'},
    {relationId:'fixture:company:sic',verdict:'SOSTENIDA',from:{db:'SEC_DATA',table:'apple_submissions_raw',column:'sic'},to:{db:'COMPANY_DNS',table:'sic_reference',column:'sic_code'},explanation:'synthetic fixture'}
  ];
  const relationsPath=path.join(ROOT,'out/U2/relaciones.json'),previous=fs.existsSync(relationsPath)?fs.readFileSync(relationsPath):null;
  fs.mkdirSync(path.dirname(relationsPath),{recursive:true});fs.writeFileSync(relationsPath,JSON.stringify({relations}));
  t.after(()=>{if(previous!==null)fs.writeFileSync(relationsPath,previous);else fs.rmSync(relationsPath,{force:true});});
  const plan=buildCompleteUsl('U2',relations),sent:string[]=[];
  const response=(sql:string,rows:any[][])=>({sql,rows,utc:'2026-01-01',requestId:'synthetic',queryId:'synthetic',durationMs:1});
  const existing=await demoUsl('U2',stubClient(async(sql:string)=>{sent.push(sql);return response(sql,sql.startsWith('LOAD')?[[JSON.stringify({tables:plan.plans.map(p=>({name:p.name}))})]]:[['synthetic']]);}));
  assert.equal(existing.status,'REUSED_EXISTING');assert.equal(existing.modelDetails.tables.length,plan.plans.length);assert.equal(sent.length,2);assert.ok(sent.every(sql=>!/COMPILE|UPDATE|ACTIVATE/.test(sql)));
  sent.length=0;
  const fresh=await demoUsl('U2',stubClient(async(sql:string)=>{sent.push(sql);if(sql.startsWith('LOAD'))throw new SafeError('ZETARIS_APPLICATION_ERROR',undefined,'USL model does not exist');return response(sql,[['synthetic']]);}));
  assert.equal(fresh.status,'NEW_MODEL');assert.equal(sent.filter(sql=>sql.startsWith('COMPILE')).length,1);assert.equal(sent.filter(sql=>sql.startsWith('ACTIVATE')).length,3);assert.ok(!sent.some(sql=>sql.startsWith('UPDATE')));
  for(const error of [new SafeError('NETWORK_ERROR'),new SafeError('HTTP_ERROR',404,'endpoint not found')]){
    sent.length=0;await assert.rejects(demoUsl('U2',stubClient(async(sql:string)=>{sent.push(sql);throw error;})));assert.equal(sent.length,1);
  }
});
test('HTML escapes SQL, source labels and model text; no external resources',()=>{
  assert.equal(escapeHtml('<script>"&'),'&lt;script&gt;&quot;&amp;');
  const bundle={sourceUtc:'2026-01-01',artifacts:{relaciones:{relations:[]},fichas:{fichas:[]},eval:{},'usl-demo':{}},ledger:[],receipts:[]};
  const html=reportHtml('U1',{sampleMode:true,runId:'fixture',mode:'offline'},bundle);
  assert.ok(html.includes('CACHED 2026-01-01'));assert.ok(!/<script|<link|<img|<iframe|https?:\/\//i.test(html));
});
test('MaDI SQL traces stay in ignored output, not the shared versioned trace',()=>{
  assert.equal(traceFileForRun('d3-U3-20260101T000000Z'),path.join(ROOT,'out/U3/trace.jsonl'));
  assert.equal(traceFileForRun('d3-register-U3-20260101T000000Z'),path.join(ROOT,'out/U3/trace.jsonl'));
  assert.equal(traceFileForRun('d3-U1-20260101T000000Z'),path.join(ROOT,'evidence/trace.jsonl'));
});
test('per-run trace and metrics exclude other runs in the shared append-only log',()=>{
  const lines=[{run:'runA',sql:'SELECT 1'},{run:'runB',sql:'SELECT 2'},{sql:'legacy'}].map(x=>JSON.stringify(x)).join('\n');
  assert.deepEqual(isolateTrace(lines,'runA'),[{run:'runA',sql:'SELECT 1'}]);
});
test('SAMPLE_MODE runs with network and credential/budget reads forbidden',async(t)=>{
  const fetchOriginal=globalThis.fetch,readOriginal=fs.readFileSync,envOriginal=process.env.SAMPLE_MODE;
  let calls=0;const source=loadCache('U1',true)!;
  fs.readFileSync=((file:any,...args:any[])=>{
    const name=String(file).replaceAll('\\','/');
    if(name.endsWith('/.env')||name.endsWith('/.concordia/budget.json'))throw new Error('SAMPLE MUST NOT READ ENV OR BUDGET');
    return (readOriginal as any)(file,...args);
  }) as any;
  globalThis.fetch=async()=>{calls++;throw new Error('SAMPLE MUST NOT USE NETWORK');};process.env.SAMPLE_MODE='true';
  try{
    const result=await demo('U1');assert.equal(calls,0);assert.equal(result.generations,0);assert.equal(result.sondas,0);assert.equal(result.cacheLabel,snapshotLabel(source));
    const html=readOriginal(path.join(ROOT,'out/U1/report.html'),'utf8');assert.ok(html.includes(snapshotLabel(source)));
  }finally{globalThis.fetch=fetchOriginal;fs.readFileSync=readOriginal;if(envOriginal===undefined)delete process.env.SAMPLE_MODE;else process.env.SAMPLE_MODE=envOriginal;}
});
