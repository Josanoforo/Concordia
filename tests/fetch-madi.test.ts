import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ROOT } from '../src/runtime.ts';
const moduleUrl=pathToFileURL(path.join(ROOT,'scripts/fetch-madi.mjs')).href;
const {planMadi,parseArgs,main}=await import(moduleUrl);

test('MaDI plans preserve companies and isolate four real domains to base/input',()=>{
  for(const domain of ['companies','games','music','products','papers']){
    const plan=planMadi(domain);
    assert.ok(plan.files.length>=8);
    assert.equal(plan.scope,`use cases/${domain}/base/input/`);
    assert.equal(plan.localEvaluationOnly,true);assert.equal(plan.redistributionAuthorized,false);
    assert.ok(plan.destination.startsWith(path.join(ROOT,'.concordia','data','madi')));
    for(const f of plan.files){
      assert.equal(f.source,plan.scope+f.path);
      assert.ok(/^(data\/[^/]+\.(csv|json|jsonl)|schemamatching\/(target_schema|sm_mapping_gold)\.json)$/.test(f.path));
      assert.ok(!/entitymatching|fusion|normalization|results/.test(f.source));
    }
  }
  assert.equal(planMadi().destination,path.join(ROOT,'.concordia','data','madi'));
  assert.ok(planMadi('papers').files.some((f:any)=>f.path==='data/crossref.jsonl'));
  assert.ok(planMadi('products').files.some((f:any)=>f.path==='data/dataset_4.json'));
  assert.throws(()=>planMadi('../papers'),/Unsupported/);
  assert.throws(()=>planMadi('__proto__'),/Unsupported/);
  assert.throws(()=>parseArgs(['--domain','music','--domain=papers']),/Duplicate/);
  assert.throws(()=>parseArgs(['--domain','--dry-run']),/Missing/);
  assert.throws(()=>parseArgs(['--destination=elsewhere']),/Unsupported/);
});
test('MaDI dry-run executes without network or creating dataset inputs',async()=>{
  const originalFetch=globalThis.fetch,originalLog=console.log;
  const originals={writeFileSync:fs.writeFileSync,mkdirSync:fs.mkdirSync,renameSync:fs.renameSync};
  let calls=0;const plans:any[]=[];
  const noWrite=()=>{throw new Error('Filesystem writes forbidden in dry-run');};
  fs.writeFileSync=noWrite;fs.mkdirSync=noWrite;fs.renameSync=noWrite;
  globalThis.fetch=async()=>{calls++;throw new Error('Network forbidden in dry-run');};
  console.log=(text:any)=>plans.push(JSON.parse(text));
  try{for(const domain of ['games','music','products','papers'])await main(['--domain='+domain,'--dry-run']);}
  finally{globalThis.fetch=originalFetch;console.log=originalLog;Object.assign(fs,originals);}
  assert.equal(calls,0);assert.equal(plans.length,4);
  for(const plan of plans){assert.equal(plan.dryRun,true);assert.equal(plan.downloadedFiles,0);assert.equal(plan.writtenFiles,0);}
  const output=execFileSync(process.execPath,['--require',path.join(ROOT,'scripts/ci-no-services.cjs'),path.join(ROOT,'scripts/fetch-madi.mjs'),'--domain','games','--dry-run'],{cwd:ROOT,encoding:'utf8',windowsHide:true});
  assert.equal(JSON.parse(output).domain,'games');
});
