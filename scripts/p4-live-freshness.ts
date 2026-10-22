import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { Zetaris } from '../src/clients/zetaris.ts';
import { assessFreshness } from '../src/probe/evidence-contract.ts';
import { compareLabels } from '../src/probe/index.ts';
import { classify } from '../src/probe/verdicts.ts';
import { Reconciler } from '../src/reconcile/index.ts';
import { ROOT, failure, loadLocalEnv, readJson, SafeError, writeJson } from '../src/runtime.ts';
import { identifier } from '../src/clients/zetaris.ts';

const db='MADI08_P4_FRESHNESS',datasetPath='.concordia/data/p4-freshness';
const mountRoot='/home/zetaris/customer-data/shared/concordia-p4-freshness-v1';
const headers=['id','label'];
const csv=(rows:string[][])=>[headers,...rows].map(row=>row.map(v=>/[",\r\n]/.test(v)?'"'+v.replaceAll('"','""')+'"':v).join(',')).join('\n')+'\n';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const endpoint=(table:string)=>({db,table,column:'id'});
function writeFixture(name:string,rows:string[][]){const target=path.join(ROOT,datasetPath,name+'.csv');fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,csv(rows));return target;}
function docker(args:string[],env:NodeJS.ProcessEnv){return execFileSync('wsl.exe',['--exec','docker',...args],{cwd:ROOT,env,encoding:'utf8',windowsHide:true,timeout:30000,stdio:['ignore','pipe','pipe']}).replaceAll('\u0000','').trim();}
async function main(){
  const env={...process.env};for(const k of ['ZETARIS_API_KEY','METERLESS_RUNTIME_TOKEN'])delete env[k];
  const driver=docker(['ps','--filter','label=com.docker.compose.project=zetaris','--filter','label=com.docker.compose.service=driver','--format','{{.ID}}'],env);
  if(!/^[a-f0-9]{12,64}$/.test(driver))throw new SafeError('UNAMBIGUOUS_DRIVER_REQUIRED');
  const mounts=JSON.parse(docker(['inspect','--format','{{json .Mounts}}',driver],env));if(!mounts.some((m:any)=>m.Destination==='/home/zetaris/customer-data'))throw new SafeError('EXPECTED_CUSTOMER_DATA_VOLUME_REQUIRED');
  const files={source:writeFixture('source',[['a','North'],['b','West'],['c','Central']]),target:writeFixture('target',[['a','North'],['b','West'],['c','Central']]),target_altered:writeFixture('target-altered',[['a','Other'],['b','Elsewhere'],['c','Unknown']])};
  const paths:any={};
  for(const [name,file] of Object.entries(files)){const target=`${mountRoot}/${name}.csv`,local='/mnt/'+file[0].toLowerCase()+file.slice(2).replaceAll('\\','/');docker(['exec',driver,'mkdir','-p',mountRoot],env);let actual:string|null=null;try{actual=docker(['exec',driver,'sha256sum',target],env).split(/\s+/)[0];}catch(e){if(!/No such file or directory/.test(String((e as any).stderr??'')))throw e;}const expected=createHash('sha256').update(fs.readFileSync(file)).digest('hex');if(actual&&actual!==expected)throw new SafeError('P4_FIXTURE_PATH_COLLISION');if(!actual)docker(['cp',local,driver+':'+target],env);if(docker(['exec',driver,'sha256sum',target],env).split(/\s+/)[0]!==expected)throw new SafeError('P4_FIXTURE_COPY_HASH_MISMATCH');paths[name]=target;}
  loadLocalEnv();const z=new Zetaris(),dbs=await z.listDatabases();if(!dbs.rows.some(r=>r[0]===db))await z.runSql(`CREATE LIGHTNING DATABASE ${identifier(db)} DESCRIBE BY "Isolated Concordia P4 freshness contract fixture"`,1);
  const listed=await z.listTables(db),existing=new Set(listed.rows.flat().map(String));
  for(const table of Object.keys(files)){if(!existing.has(table))await z.runSql(`CREATE LIGHTNING FILESTORE TABLE ${identifier(table)} FROM ${identifier(db)} FORMAT CSV OPTIONS (PATH "${paths[table]}", header "true", inferSchema "false")`,1);}
  const thresholds=readJson('config/thresholds.json'),normalization='text',sourceSchema=['id','label'],schemaVersion=hash([sourceSchema,sourceSchema]);
  const observe=async(target:string)=>{const queries=[await z.runSql(`SELECT id, label FROM ${db}.source LIMIT 10`,10),await z.runSql(`SELECT id, label FROM ${db}.${target} LIMIT 10`,10)];
    const ids=new Set(queries[1].rows.map(r=>String(r[0]))),matched=queries[0].rows.filter(r=>ids.has(String(r[0]))).length,labels=compareLabels(queries[0].rows,queries[1].rows,headers,headers,endpoint('source'),endpoint(target),['label'],['label'],'text');
    const evidence:any={status:'PASS',overlap:{matched,probed:queries[0].rows.length,ratio:queries[0].rows.length?matched/queries[0].rows.length:null,sampleKeys:[]},typeCompat:{castable:true},alerts:[],labelAgreement:labels,queries};
    const decision=classify(evidence,thresholds),sourceVersion=hash(queries.map(q=>q.rows)),observedAt=new Date().toISOString();
    const freshness=assessFreshness(null,{sourceVersion,schemaVersion,normalization,observedAt,verdict:decision.verdict});return {evidence,decision,sourceVersion,schemaVersion,observedAt,requestIds:queries.map(q=>q.requestId),freshness};};
  const cold=await observe('target');
  const warmRaw=await observe('target');const warm=assessFreshness({sourceVersion:cold.sourceVersion,schemaVersion,normalization,observedAt:cold.observedAt,verdict:cold.decision.verdict},{sourceVersion:warmRaw.sourceVersion,schemaVersion,normalization,observedAt:warmRaw.observedAt,verdict:warmRaw.decision.verdict});
  const alteredRaw=await observe('target_altered');const altered=assessFreshness({sourceVersion:warmRaw.sourceVersion,schemaVersion,normalization,observedAt:warmRaw.observedAt,verdict:warmRaw.decision.verdict},{sourceVersion:alteredRaw.sourceVersion,schemaVersion,normalization,observedAt:alteredRaw.observedAt,verdict:alteredRaw.decision.verdict});
  const relationId='p4_fixture.source.id__target.id',from=endpoint('source'),to=endpoint('target');
  const ledger=new Reconciler('P4',path.join(ROOT,'.concordia','p4-freshness-ledger-'+Date.now()),'p4-live-watcher');
  const payload=(decision:any,observed:any,fresh:any)=>({relations:[{relationId,from,to,verdict:fresh.state==='DEGRADADA'?'INDETERMINADA':decision.verdict,rule:fresh.state==='DEGRADADA'?'freshness_changed_requires_review':decision.rule,
    freshness:{...fresh,sourceVersion:observed.sourceVersion,schemaVersion,sourceObservedAt:observed.observedAt},evidence:{...observed.evidence,utc:observed.observedAt,freshness:{...fresh,sourceVersion:observed.sourceVersion,schemaVersion,sourceObservedAt:observed.observedAt}}}]});
  ledger.ingest({tables:{}},payload(cold.decision,cold,cold.freshness));const historical=ledger.claims.find(c=>c.entity==='relation:'+relationId&&c.value==='SOSTENIDA');
  ledger.ingest({tables:{}},payload(alteredRaw.decision,alteredRaw,altered));const current=ledger.claims.find(c=>c.entity==='relation:'+relationId&&c.value==='INDETERMINADA');
  const superseded=Boolean(historical&&ledger.hmem.store.get(historical.id)?.supersededBy===current?.id);
  const result={utc:new Date().toISOString(),status:cold.freshness.state==='FRIA'&&warm.state==='REVALIDADA'&&altered.state==='DEGRADADA'&&alteredRaw.decision.verdict==='ENGAÑOSA'&&superseded?'PASS':'FAIL',fixture:'isolated synthetic tables in live Zetaris; no source U1 rows changed',database:db,conditions:{cold:{state:cold.freshness.state,verdict:cold.decision.verdict,requestIds:cold.requestIds},warmSame:{state:warm.state,verdict:warmRaw.decision.verdict,changed:warm.changed,requestIds:warmRaw.requestIds},warmAltered:{state:altered.state,currentProbeVerdict:alteredRaw.decision.verdict,decisionVerdict:altered.verdict,requiresReview:altered.requiresReview,supersedePrevious:altered.supersedePrevious,requestIds:alteredRaw.requestIds}},historicalClaimPreserved:Boolean(historical),historicalClaimSuperseded:superseded,currentClaim:current?.value??null,invalidatedRequestIds:cold.requestIds};
  writeJson('evidence/p4-freshness-live.json',result);if(result.status!=='PASS')throw new SafeError('P4_LIVE_FRESHNESS_CONTRACT_FAILED');console.log(JSON.stringify({status:result.status,conditions:Object.fromEntries(Object.entries(result.conditions).map(([k,v]:any)=>[k,{state:v.state,verdict:v.decisionVerdict??v.currentProbeVerdict??v.verdict}])),historicalClaimSuperseded:superseded,currentClaim:current?.value}));
}
main().catch(error=>{console.error('FAIL',JSON.stringify(failure(error)));process.exitCode=1;});
