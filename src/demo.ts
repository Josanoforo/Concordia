import fs from 'node:fs';
import path from 'node:path';
import { discover } from './discovery/index.ts';
import { probe } from './probe/index.ts';
import { verdicts, writeRelations } from './probe/verdicts.ts';
import { evaluate } from './eval.ts';
import { Reconciler, reconcile } from './reconcile/index.ts';
import { Nightshift } from './clients/nightshift.ts';
import { Zetaris } from './clients/zetaris.ts';
import { failure, readJson, writeJson, ROOT, setTraceRun, stamp, SafeError, traceFileForRun } from './runtime.ts';
import { budgetFilePath, readBudget } from './budget.ts';
import { discoverUniverse, probeUniverse, evaluateUniverse, universeConfig } from './universe-pipeline.ts';
import { discoverMappings, probeMappings, evaluateMadi } from './madi.ts';
import { demoUsl } from './usl/demo.ts';
import { artifacts, cacheFingerprint, captureCache, ledgerRows, loadCache, isolateTrace, snapshotLabel } from './demo-cache.ts';
import { writeReport } from './report/index.ts';
import { uslDossier } from './usl/dossier.ts';
import { criticize } from './critic/adversarial.ts';
import { evaluateCritic } from './critic/eval.ts';

export async function optionalNightshift(check:()=>Promise<unknown>) {
  try{await check();return {status:'AVAILABLE',explanations:'deterministic templates; unchanged historical LLM explanations reused with date/receipt; no new generation necessary'};}
  catch(error){return {status:'DETERMINISTIC_FALLBACK',reason:failure(error),explanations:'Nightshift unavailable; deterministic templates; no retry'};}
}
export async function requireZetaris(check:()=>Promise<unknown>) {
  try{await check();}catch(error){throw new SafeError('ZETARIS_UNAVAILABLE_STOP_NO_SIMULATED_PROBES',undefined,JSON.stringify(failure(error)));}
}
const budget=()=>fs.existsSync(budgetFilePath())?readBudget():{consumed:0,attempts:[]};
export async function demo(universeId='U1') {
  const started=performance.now(),sampleMode=process.env.SAMPLE_MODE==='true',runId='d4a-'+universeId+'-'+stamp();
  const cached=loadCache(universeId,sampleMode);
  if(sampleMode){
    const snapshot=structuredClone(cached!),label=snapshotLabel(snapshot);
    for(const key of artifacts)if(snapshot.artifacts[key])writeJson(`out/${universeId}/${key}.json`,snapshot.artifacts[key]);
    snapshot.artifacts.dossier=uslDossier(universeId,{snapshot,sample:true});
    const r=snapshot.artifacts.relaciones.relations,f=snapshot.artifacts.fichas;
    const run:any={runId,utc:new Date().toISOString(),universe:universeId,sampleMode:true,live:false,sourceUtc:snapshot.sourceUtc,cacheLabel:label,syntheticFixture:Boolean(snapshot.publicFixture),mode:'offline-replay',status:'PASS',sondas:0,generations:0,models:[],verdicts:counts(r),conflicts:conflictCounts(f),critic:snapshot.artifacts.critic?{confirmed:snapshot.artifacts.critic.confirmed,degraded:snapshot.artifacts.critic.degraded,insufficient:snapshot.artifacts.critic.insufficient,errors:snapshot.artifacts.critic.errors,skipped:snapshot.artifacts.critic.skipped,utc:snapshot.artifacts.critic.utc}:null,criticEval:snapshot.artifacts['critic-eval']??null,durationMs:Math.round(performance.now()-started),nightshift:'No network or generation',coldWarm:'Offline sample; not a live warm benchmark'};
    // No .env, clients, H-MEM query or budget access in this branch.
    run.report=writeReport(universeId,run,snapshot);
    writeReport(universeId,run,snapshot,'sample');writeJson(`out/${universeId}/sample/metrics.json`,run);
    console.log(label,JSON.stringify(run));return run;
  }
  const fingerprint=cacheFingerprint(universeId),warm=cached?.fingerprint===fingerprint&&Date.now()-cached.createdAt<86400000;
  const dir=`evidence/runs/${runId}`,tracePath=traceFileForRun(runId),offset=fs.existsSync(tracePath)?fs.readFileSync(tracePath,'utf8').length:0;
  const before=budget(),run:any={runId,utc:new Date().toISOString(),universe:universeId,sampleMode:false,fingerprint,mode:warm?'warm':'cold',status:'IN_PROGRESS',sondas:0,generations:0,models:[],cacheTTLHours:24};
  setTraceRun(runId);
  try{
    await requireZetaris(()=>new Zetaris().listDatabases());
    const memory=new Reconciler(universeId),reinjection=memory.reinject();run.correctedMemoryIds=reinjection.correctionIds;
    writeJson(dir+'/reinjection.json',reinjection);
    if(warm){
      for(const key of artifacts)writeJson(`out/${universeId}/${key}.json`,cached.artifacts[key]);
      run.cacheLabel='CACHED '+cached.sourceUtc;run.sourceUtc=cached.sourceUtc;
      run.nightshift={status:'NOT_CALLED_WARM',explanations:'CACHED '+cached.sourceUtc};
    }else{
      if(universeId==='U1')await coldU1();
      else if(universeConfig(universeId).kind==='schema-matching'){await discoverMappings(universeId);await probeMappings(universeId);}
      else{await discoverUniverse(universeId);await probeUniverse(universeId);}
      run.nightshift=await optionalNightshift(()=>new Nightshift().models());
    }
    const relationsBeforeCritic=readJson<any>(`out/${universeId}/relaciones.json`);
    if(!relationsBeforeCritic.critic?.results?.length){run.critic=await criticize(universeId);run.criticEval=evaluateCritic(universeId);}
    else {run.critic=relationsBeforeCritic.critic;run.criticEval=fs.existsSync(path.join(ROOT,`out/${universeId}/critic-eval.json`))?readJson(`out/${universeId}/critic-eval.json`):null;}
    run.eval=universeId==='U1'?evaluate():universeId==='U3'?evaluateMadi():evaluateUniverse(universeId);
    const fichas=reconcile(universeId);
    const usl=await demoUsl(universeId);writeJson(`out/${universeId}/usl-demo.json`,usl);
    const after=budget(),attempts=after.attempts.slice(before.consumed);
    run.generations=after.consumed-before.consumed;run.cumulativeGenerations=after.consumed;
    run.models=attempts.map((a:any)=>a.receipt?.model??'no confirmed receipt');
    const events=isolateTrace(fs.readFileSync(tracePath,'utf8').slice(offset),runId);
    run.sondas=events.filter(e=>e.kind==='zetaris'&&/^SELECT /i.test(e.sql)&&!e.sql.includes('lightning.metastore')&&/ WHERE /i.test(e.sql)).length;
    run.sqlCalls=events.filter(e=>e.kind==='zetaris').length;
    run.verdicts=counts(readJson(`out/${universeId}/relaciones.json`).relations);run.conflicts=conflictCounts(fichas);
    run.status='PASS';run.durationMs=Math.round(performance.now()-started);
    const comparisonFile=`evidence/cold-warm-D3-${universeId}.json`;
    const comparison=fs.existsSync(path.join(ROOT,comparisonFile))?readJson(comparisonFile):{};
    comparison[run.mode]={runId,utc:run.utc,sondas:run.sondas,sqlCalls:run.sqlCalls,generations:run.generations,durationMs:run.durationMs,models:run.models};
    run.coldWarm=comparison;writeJson(comparisonFile,comparison);
    const ledger=ledgerRows(universeId),receipts=after.attempts.filter((a:any)=>a.receipt).map((a:any)=>({utc:a.utc,status:a.status,cacheLabel:'CACHED '+a.utc,...a.receipt}));
    let snapshot:any;
    if(!warm)snapshot=captureCache(universeId,run,ledger,receipts);
    else snapshot={...cached,ledger,artifacts:{...cached.artifacts,fichas,'usl-demo':usl,eval:run.eval}};
    snapshot.artifacts.dossier=uslDossier(universeId);
    run.report=writeReport(universeId,run,snapshot);
    writeJson(dir+'/receipts.json',attempts);writeJson(dir+'/metrics.json',run);
    console.log(`${run.cacheLabel??'LIVE '+run.utc} ${universeId} ${run.mode}: ${JSON.stringify({status:run.status,verdicts:run.verdicts,conflicts:run.conflicts,probes:run.sondas,generations:run.generations,models:run.models,durationMs:run.durationMs,coldWarm:run.coldWarm,report:run.report})}`);
    return run;
  }catch(error){
    run.status='BLOCKED';run.error=failure(error);run.durationMs=Math.round(performance.now()-started);
    writeJson(dir+'/metrics.json',run);
    fs.appendFileSync(path.join(ROOT,'docs/reportes/REPORTE_D3.md'),`\n## Bloqueo ${runId}\n\n${JSON.stringify(run.error)}\n\nSe detiene según sección 0. Evidencia: ${dir}/metrics.json.\n`);
    throw error;
  }finally{
    fs.mkdirSync(path.join(ROOT,dir),{recursive:true});
    const events=fs.existsSync(tracePath)?isolateTrace(fs.readFileSync(tracePath,'utf8').slice(offset),runId):[];
    fs.writeFileSync(path.join(ROOT,dir,'trace.jsonl'),events.map(e=>JSON.stringify(e)).join('\n')+'\n');
    setTraceRun();
  }
}
const counts=(relations:any[])=>Object.fromEntries(['SOSTENIDA','ENGAÑOSA','INDETERMINADA'].map(v=>[v,relations.filter(r=>r.verdict===v).length]));
const conflictCounts=(f:any)=>Object.fromEntries(['queued','auto_resolved','human_resolved'].map(v=>[v,(f.conflicts??[]).filter((c:any)=>c.status===v).length]));
async function coldU1(){
  const oldInventory=readJson('out/U1/discovery.json'),oldRelations=readJson('out/U1/relaciones.json');
  const excluded=readJson('config/cost-exclusions.json').U1 as string[];
  const oldProbes=readJson('out/U1/probes.json').probes;
  const inventory=await discover({excludedTables:excluded,cached:oldInventory});
  if(inventory.errors.length)throw new SafeError('U1_DISCOVERY_FAILED');
  for(const candidate of oldInventory.candidates)if(!inventory.candidates.some((c:any)=>c.id===candidate.id))inventory.candidates.push(candidate);
  writeJson('out/U1/discovery.json',inventory);
  const isExcluded=(c:any)=>excluded.includes(c.from.table)||excluded.includes(c.to.table);
  const preserved=oldProbes.filter((p:any)=>isExcluded(p.relation)).map((p:any)=>({...p,costExcluded:true,cacheLabel:'CACHED '+p.utc}));
  writeJson('out/U1/probes.json',{utc:new Date().toISOString(),probes:preserved});
  const probes=await probe({candidateIds:inventory.candidates.filter(c=>!isExcluded(c)).map(c=>c.id),append:true});
  if(probes.some(p=>p.status!=='PASS'))throw new SafeError('U1_PROBE_FAILED');
  const output:any=verdicts();output.pending_llm=false;
  for(const r of output.relations){
    const old=oldRelations.relations.find((p:any)=>p.relationId===r.relationId);r.pending_llm=false;
    if(old?.verdict===r.verdict&&old.llmExplanation){
      r.llmExplanation=old.llmExplanation;r.llmReceipt=old.llmReceipt;
      const generation=budget().attempts.find((a:any)=>a.receipt?.receiptId===old.llmReceipt?.receiptId);
      r.llmCacheLabel=generation?'CACHED '+generation.utc:'CACHED historical generation; UTC unavailable';
      r.explanationSource='deterministic-template-plus-historical-LLM';
    }
  }
  writeRelations(output);
}
