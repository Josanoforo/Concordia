import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Zetaris, identifier } from './clients/zetaris.ts';
import { ROOT, readJson, writeJson, SafeError, failure, loadLocalEnv, sanitize } from './runtime.ts';
import { buildDossier, relationContract } from './usl/dossier.ts';
import { readActiveReconcileSnapshot } from './reconcile/persistence.ts';
import { assessConsumerInputVersions, consumerFreshnessSnapshot, type ConsumerFreshnessSnapshot, type ConsumerInputVersion } from './reconcile/consumer-freshness.ts';

export const decisionTableSpecs: Record<string,string[]> = {
  concordia_verdicts:['universe','relation','relationId','from','to','verdict','confidence','evidenceId','requestId','utc'],
  concordia_negative_usl:['universe','relationId','from','to','verdict','reason','evidenceId','requestId','utc'],
  concordia_ledger:['universe','id','entity','attribute','action','source','actor','utc']
};
const csv=(v:unknown)=>'"'+String(v??'').replaceAll('"','""')+'"';
export const encodeDecisionCsv=(headers:string[],rows:unknown[][])=>[headers,...rows].map(row=>row.map(csv).join(',')).join('\r\n')+'\r\n';

/** Parse RFC-style quoted CSV including embedded commas, quotes and newlines. */
export function decodeDecisionCsv(text:string):string[][] {
  const rows:string[][]=[];let row:string[]=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(c==='"'&&quoted&&text[i+1]==='"'){cell+='"';i++;}
    else if(c==='"')quoted=!quoted;
    else if(c===','&&!quoted){row.push(cell);cell='';}
    else if((c==='\r'||c==='\n')&&!quoted){
      if(c==='\r'&&text[i+1]==='\n')i++;
      row.push(cell);rows.push(row);row=[];cell='';
    } else cell+=c;
  }
  if(quoted)throw new SafeError('DECISIONS_CSV_UNCLOSED_QUOTE');
  if(cell.length||row.length){row.push(cell);rows.push(row);}
  return rows;
}

export function buildDecisionLedgerRows(id:string,ledger:any[],claims:any[]) {
  const claimById=new Map(claims.map((c:any)=>[c.id,c]));
  return ledger.map((entry:any,index:number)=>{
    const claim:any=claimById.get(entry.memoryId),state=entry.newState??entry.previousState??{};
    const utc=entry.timestamp?new Date(entry.timestamp).toISOString():'';
    const stableId=createHash('sha256').update(`${id}|${entry.memoryId??''}|${entry.action??''}|${entry.timestamp??''}|${entry.actor??''}|${index}`).digest('hex').slice(0,24);
    // Publish ledger metadata only. Claim values and state payloads are intentionally omitted.
    return [id,stableId,claim?.entity??'',claim?.attribute??'',entry.action??'',claim?.source??state.source??'',entry.actor??'',utc];
  });
}

function endpoint(e:any){return `${e?.db??''}.${e?.table??''}.${e?.column??''}`;}
export function decisionReason(r:any){
  if(r.critic?.status==='DEGRADED')return 'critic_downgrade';
  if(r.verdict==='ENGAÑOSA')return 'misleading_join';
  if(r.normalization==='text'&&r.verdict==='INDETERMINADA')return 'unsafe_literal_key_format';
  return typeof r.rule==='string'&&/^[a-z0-9_]+$/i.test(r.rule)?r.rule:'relation_excluded';
}
function buildLocalRows(id:string,relationFile:any,inventory:any,model:any,ledger:any[],claims:any[],reconcileConfig:any,thresholds:any,excluded:string[],comment:any){
  const relations=relationFile.relations;
  const contractById=new Map(relations.map((r:any)=>[r.relationId,relationContract(r,reconcileConfig,excluded)]));
  const verdictRows=relations.map((r:any)=>{
    const c:any=contractById.get(r.relationId);
    return [id,r.relationId,r.relationId,endpoint(r.from),endpoint(r.to),r.verdict,c.confidence,c.evidenceId,(c.evidence.requestIds??[]).join(';'),c.evidence.utc??''];
  });
  const dossier=buildDossier(id,inventory,relationFile,model,reconcileConfig,thresholds,excluded,comment);
  const negativeIds=new Set<string>(dossier.forbidden.map((c:any)=>c.relationId));
  const negative=relations.filter((r:any)=>negativeIds.has(r.relationId));
  const negativeRows=negative.map((r:any)=>{
    const c:any=contractById.get(r.relationId);
    return [id,r.relationId,endpoint(r.from),endpoint(r.to),r.verdict,decisionReason(r),c.evidenceId,(c.evidence.requestIds??[]).join(';'),c.evidence.utc??''];
  });
  return {rows:{concordia_verdicts:verdictRows,concordia_negative_usl:negativeRows,concordia_ledger:buildDecisionLedgerRows(id,ledger,claims)},negativeIds:[...negativeIds]};
}

function readOtherUniverseRows(id:string,name:string,headers:string[]) {
  const file=path.join(ROOT,'out',id,'decisions',name+'.csv');
  if(!fs.existsSync(file))return [];
  const parsed=decodeDecisionCsv(fs.readFileSync(file,'utf8'));
  if(!parsed.length||parsed[0].join('\0')!==headers.join('\0'))throw new SafeError('DECISIONS_CSV_SCHEMA_MISMATCH');
  return parsed.slice(1).filter(row=>row.length===headers.length);
}

export function buildDecisionExportManifest(id:string,dryRun:boolean,freshness:ConsumerFreshnessSnapshot,negativeRelationIds:string[],files:unknown[]=[],utc=new Date().toISOString(),relationInputs:readonly ConsumerInputVersion[]=[]){
  const assessedFreshness=assessConsumerInputVersions(freshness,relationInputs);
  return {utc,universe:id,status:dryRun?'DRY_RUN':'PREPARED',dryRun,negativeRelationIds:[...negativeRelationIds],freshness:assessedFreshness,files};
}
export async function publishDecisions(id='U1',dryRun=false){
  if(!['U1','U2'].includes(id))throw new SafeError('PUBLISH_UNIVERSE_UNSUPPORTED');
  const priorManifestFile=path.join(ROOT,'out',id,'decisions','manifest.json');
  const priorManifest=fs.existsSync(priorManifestFile)?JSON.parse(fs.readFileSync(priorManifestFile,'utf8')):null;
  const priorPass=priorManifest?.status==='PASS'?priorManifest:null;
  const relationFile=readJson<any>(`out/${id}/relaciones.json`);
  const reconcileDir=path.join(ROOT,'.concordia',id),active=readActiveReconcileSnapshot(reconcileDir,id);
  if(!active&&(fs.existsSync(path.join(reconcileDir,'claims.json'))||fs.existsSync(path.join(reconcileDir,'state.json'))||fs.existsSync(path.join(reconcileDir,'ledger.jsonl'))))throw new SafeError('RECONCILE_SNAPSHOT_REQUIRED');
  const ledger=active?.ledger??[],claims=active?.claims??[];
  const reconcileConfig=readJson<any>('config/reconcile.json'),excluded=readJson<any>('config/cost-exclusions.json')[id]??[];
  const commentFile=path.join(ROOT,'evidence/comment-probe-04b.json');
  const freshness=consumerFreshnessSnapshot(id,relationFile.relations.map((relation:any)=>relation.relationId),priorManifest?.freshness,{mode:'REGENERATE'});
  const built=buildLocalRows(id,relationFile,readJson(`out/${id}/discovery.json`),readJson(`out/${id}/usl-complete.json`),ledger,claims,reconcileConfig,readJson('config/thresholds.json'),excluded,fs.existsSync(commentFile)?readJson('evidence/comment-probe-04b.json'):null);
  const rows:any=built.rows,outDir=path.join(ROOT,'out',id,'decisions');
  const local:any=buildDecisionExportManifest(id,dryRun,freshness,built.negativeIds,[],new Date().toISOString(),relationFile.relations.map((r:any)=>({relationId:r.relationId,verdict:r.verdict,contractVersion:r.contractVersion??r.contract?.contractVersion,decisionRef:r.decisionRef??r.decision?.decisionId,policyVersion:r.policyVersion??r.decision?.policyVersion,evidenceRefs:r.evidenceRefs??r.decision?.evidenceBundleRefs})));
  fs.mkdirSync(outDir,{recursive:true});
  for(const [name,headers] of Object.entries(decisionTableSpecs)){
    const body=encodeDecisionCsv(headers,rows[name]);
    const file=path.join(outDir,name+'.csv');fs.writeFileSync(file,body);
    local.files.push({table:name,path:file,rows:rows[name].length,sha256:createHash('sha256').update(body).digest('hex')});
  }
  if(priorPass){
    const previous=new Map((priorPass.files??[]).map((f:any)=>[f.table,f]));
    local.republishComparison={priorRunId:priorPass.runId??null,localCsvIdentical:local.files.every((f:any)=>{const p:any=previous.get(f.table);return Boolean(p&&p.sha256===f.sha256&&p.rows===f.rows);}),previousTables:priorPass.tablesAfter??[]};
  }
  if(dryRun){local.status='DRY_RUN';writeJson(`out/${id}/decisions/manifest.json`,local);return local;}
  local.runId=`p6-${id}-${new Date().toISOString().replace(/[-:.]/g,'')}`;
  writeJson(`out/${id}/decisions/manifest.json`,local);

  const env={...process.env};for(const k of ['ZETARIS_API_KEY','METERLESS_RUNTIME_TOKEN'])delete env[k];
  const docker=(args:string[])=>execFileSync('wsl.exe',['--exec','docker',...args],{cwd:ROOT,env,encoding:'utf8',windowsHide:true,timeout:30000,stdio:['ignore','pipe','pipe']}).replaceAll('\u0000','').trim();
  let stage='locate_driver';
  try{
    const driver=docker(['ps','--filter','label=com.docker.compose.project=zetaris','--filter','label=com.docker.compose.service=driver','--format','{{.ID}}']);
    if(!/^[a-f0-9]{12,64}$/.test(driver))throw new SafeError('UNAMBIGUOUS_DRIVER_REQUIRED');
    stage='inspect_customer_data_mount';
    const mounts=JSON.parse(docker(['inspect','--format','{{json .Mounts}}',driver]));
    const mount=mounts.find((m:any)=>m.Type==='volume'&&m.Destination==='/home/zetaris/customer-data');
    if(!mount)throw new SafeError('EXPECTED_CUSTOMER_DATA_VOLUME_REQUIRED');
    const target='/home/zetaris/customer-data/shared/concordia-decisions';stage='create_decisions_directory';docker(['exec',driver,'mkdir','-p',target]);
    const aggregateRows:any={...rows};
    for(const other of ['U1','U2'].filter(u=>u!==id)){
      for(const name of Object.keys(decisionTableSpecs))aggregateRows[name]=[...aggregateRows[name],...readOtherUniverseRows(other,name,decisionTableSpecs[name])];
    }
    for(const file of local.files){
      const name=file.table,body=encodeDecisionCsv(decisionTableSpecs[name],aggregateRows[name]),dest=`${target}/${name}.csv`;
      const aggregate=path.join(outDir,`catalog-${name}.csv`);fs.writeFileSync(aggregate,body);
      file.catalogPath=aggregate;file.catalogRows=aggregateRows[name].length;file.catalogSha256=createHash('sha256').update(body).digest('hex');
      const source='/mnt/'+aggregate[0].toLowerCase()+aggregate.slice(2).replaceAll('\\','/');
      stage='copy_and_hash_csv';docker(['cp',source,driver+':'+dest]);
      if(docker(['exec',driver,'sha256sum',dest]).split(/\s+/)[0]!==file.catalogSha256)throw new SafeError('DECISIONS_COPY_HASH_MISMATCH');
      file.containerPath=dest;
    }

    // Docker subprocesses run without application credentials. Load the local
    // runtime environment only after copying and hashing the authorized CSVs.
    stage='load_runtime_environment';loadLocalEnv();const z=new Zetaris(),db='CONCORDIA';
    stage='list_databases';
    const databases=await z.listDatabases();
    if(!databases.rows.some(r=>String(r[0])===db)){stage='create_decision_database';await z.runSql(`CREATE LIGHTNING DATABASE ${db} DESCRIBE BY "Concordia decision metadata"`,1);}
    stage='list_existing_tables';
    const tables=await z.listTables(db),tablesBefore=[...new Set(tables.rows.map(r=>String(r[0])))].sort(),existing=new Set(tablesBefore);
    for(const f of local.files){if(!existing.has(f.table)){stage='create_decision_table';await z.runSql(`CREATE LIGHTNING FILESTORE TABLE ${identifier(f.table)} FROM ${db} FORMAT CSV OPTIONS (PATH "${f.containerPath}", header "true", inferSchema "false")`,1);}}
    stage='verify_table_idempotency';
    const afterTables=await z.listTables(db),tableNames=afterTables.rows.map(r=>String(r[0])),tablesAfter=[...new Set(tableNames)].sort();
    const expectedTables=Object.keys(decisionTableSpecs).sort(),decisionTableCounts=Object.fromEntries(expectedTables.map(name=>[name,tableNames.filter(t=>t===name).length]));
    if(expectedTables.some(name=>decisionTableCounts[name]!==1))throw new SafeError('DECISIONS_TABLE_IDEMPOTENCY_FAILED');
    local.tablesBefore=tablesBefore;local.tablesAfter=tablesAfter;local.decisionTableCounts=decisionTableCounts;
    if(priorPass){
      local.republishComparison={...local.republishComparison,tablesUnchanged:JSON.stringify(priorPass.tablesAfter??[])===JSON.stringify(tablesAfter),previousRunId:priorPass.runId??null};
      if(!local.republishComparison.localCsvIdentical||!local.republishComparison.tablesUnchanged)throw new SafeError('DECISIONS_REPUBLISH_NOT_IDEMPOTENT');
    }
    const checks:any[]=[];
    for(const [table,cols] of Object.entries(decisionTableSpecs)){
      const select=cols.map(c=>['from','to'].includes(c)?'`'+c+'`':identifier(c)).join(', ');
      stage='verify_table_rows';checks.push(await z.runSql(`SELECT ${select} FROM ${db}.${identifier(table)} LIMIT 3`,3));
    }
    stage='verify_demo_queries';
    const demoVerdicts=await z.runSql(`SELECT relation, verdict FROM ${db}.concordia_verdicts WHERE verdict = 'ENGAÑOSA' LIMIT 3`,3);
    const demoLedger=await z.runSql(`SELECT universe, id, entity, attribute, action, source, actor, utc FROM ${db}.concordia_ledger WHERE entity = 'zone:1' LIMIT 3`,3);
    local.status='PASS';local.tables=checks.map((q:any)=>({sql:q.sql,requestId:q.requestId,rows:q.rows}));
    local.demoQueries=[demoVerdicts,demoLedger].map((q:any)=>({sql:q.sql,requestId:q.requestId,rows:q.rows}));
    writeJson(`out/${id}/decisions/manifest.json`,local);
    if(priorPass)writeJson(`evidence/p6/idempotency-${id}.json`,{universe:id,status:'PASS',currentRunId:local.runId,previousRunId:local.republishComparison.previousRunId,localCsvIdentical:local.republishComparison.localCsvIdentical,tablesUnchanged:local.republishComparison.tablesUnchanged,files:local.files.map((f:any)=>({table:f.table,rows:f.rows,sha256:f.sha256,catalogRows:f.catalogRows,catalogSha256:f.catalogSha256})),tablesBefore:local.tablesBefore,tablesAfter:local.tablesAfter,decisionTableCounts:local.decisionTableCounts});
    writeJson(`output_examples/${id}/decisions-verdicts.json`,demoVerdicts);
    writeJson(`output_examples/${id}/decisions-ledger.json`,demoLedger);
    return local;
  }catch(error){
    const stderr=(error as any)?.stderr,stderrText=Buffer.isBuffer(stderr)?stderr.toString('utf8'):typeof stderr==='string'?stderr:'';
    const safeStderr=stderrText?sanitize(stderrText).split(/\r?\n/)[0].slice(0,200):undefined;
    local.status='BLOCKED';local.error={...failure(error),stage,...(error instanceof SafeError?{}:{causeCode:typeof (error as any)?.code==='string'?(error as any).code:undefined,exitStatus:Number.isInteger((error as any)?.status)?(error as any).status:undefined,...(safeStderr?{detail:safeStderr}:{})})};
    writeJson(`out/${id}/decisions/manifest.json`,local);throw new SafeError(local.error.code);
  }
}