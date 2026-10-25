import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, readJson, SafeError, writeJson } from './runtime.ts';
import { readActiveReconcileSnapshot } from './reconcile/persistence.ts';
export const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function isolateTrace(text:string,runId:string) {return text.split(/\r?\n/).filter(Boolean).map(s=>JSON.parse(s)).filter(e=>e.run===runId);}
export const artifacts=['discovery','probes','relaciones','fichas','eval','usl-demo','critic','critic-eval'] as const;
const fixtureArtifacts=(id:string,relations:any[])=>({
  discovery:{universe:id,tables:{},candidates:[]},
  probes:{probes:[]},
  relaciones:{universe:id,utc:'SYNTHETIC FIXTURE',syntheticFixture:true,relations,critic:{utc:'SYNTHETIC FIXTURE',confirmed:0,degraded:0,insufficient:0,skipped:0,errors:0,results:[]}},
  fichas:{fichas:[],conflicts:[]},
  eval:{syntheticFixture:true,correct:0,total:0},
  'usl-demo':{status:'SYNTHETIC_FIXTURE',mappings:[],plans:[]},
  critic:{utc:'SYNTHETIC FIXTURE',confirmed:0,degraded:0,insufficient:0,skipped:0,errors:0,results:[]},
  'critic-eval':null
});
function loadPublicFixture(id:string) {
  const file=`output_examples/sample-fixture/${id}.json`;
  if(!fs.existsSync(path.join(ROOT,file)))throw new SafeError('SAMPLE_CACHE_MISSING_RUN_LIVE_FIRST');
  const fixture=readJson<any>(file);
  if(fixture.universe!==id||!Array.isArray(fixture.relations)||!fixture.relations.length)throw new SafeError('PUBLIC_FIXTURE_INVALID');
  const snapshot:any={sourceUtc:'SYNTHETIC FIXTURE',runId:`public-fixture-${id}`,universe:id,fingerprint:'synthetic-public-fixture-v1',createdAt:0,publicFixture:true,artifacts:fixtureArtifacts(id,fixture.relations),ledger:[],receipts:[]};
  if(artifacts.slice(0,6).some(k=>!snapshot.artifacts[k]))throw new SafeError('PUBLIC_FIXTURE_INVALID');
  return snapshot;
}
export const snapshotLabel=(snapshot:any)=>snapshot.publicFixture?'SYNTHETIC FIXTURE':'CACHED '+snapshot.sourceUtc;
export function cacheFingerprint(id:string) {
  const walk=(dir:string):string[]=>fs.readdirSync(path.join(ROOT,dir),{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+'/'+e.name):[dir+'/'+e.name]);
  const sources=[...walk('src'),...walk('config'),...walk('universes')].filter(f=>/\.(ts|json)$/.test(f)).sort();
  return digest([id,...sources.map(f=>[f,fs.readFileSync(path.join(ROOT,f),'utf8')])]);
}
export function captureCache(id:string,run:any,ledger:unknown[],receipts:unknown[]) {
  const snapshot:any={sourceUtc:run.utc,runId:run.runId,universe:id,fingerprint:run.fingerprint,createdAt:Date.now(),artifacts:{},ledger,receipts};
  for(const key of artifacts){const file=path.join(ROOT,`out/${id}/${key}.json`);snapshot.artifacts[key]=fs.existsSync(file)?readJson(`out/${id}/${key}.json`):null;}
  writeJson(`evidence/cache/${id}/${run.runId}.json`,snapshot);
  const manifest={file:`evidence/cache/${id}/${run.runId}.json`,sha256:digest(snapshot),sourceUtc:run.utc,fingerprint:run.fingerprint,createdAt:snapshot.createdAt};
  writeJson(`evidence/cache/${id}/latest.json`,manifest);
  return snapshot;
}
export function loadCache(id:string,required=false) {
  const file=`evidence/cache/${id}/latest.json`;
  if(!fs.existsSync(path.join(ROOT,file))){if(required)return loadPublicFixture(id);return null;}
  const manifest=readJson(file);
  if(!new RegExp('^evidence/cache/'+id+'/(?:d3|d4a)-'+id+'-[0-9TZ]+\\.json$').test(manifest.file))throw new SafeError('INVALID_CACHE_PATH');
  const snapshot=readJson(manifest.file);
  if(digest(snapshot)!==manifest.sha256)throw new SafeError('CACHE_CHECKSUM_MISMATCH');
  if(snapshot.universe!==id||!snapshot.sourceUtc||artifacts.slice(0,6).some(k=>!snapshot.artifacts[k]))throw new SafeError('CACHE_INCOMPLETE');
  return snapshot;
}
export function ledgerRows(id:string) {
  const dir=path.join(ROOT,'.concordia',id),active=readActiveReconcileSnapshot(dir,id);
  if(!active&&(fs.existsSync(path.join(dir,'claims.json'))||fs.existsSync(path.join(dir,'state.json'))||fs.existsSync(path.join(dir,'ledger.jsonl'))))throw new SafeError('RECONCILE_SNAPSHOT_REQUIRED');
  return active?.ledger??[];
}
