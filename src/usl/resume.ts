import fs from 'node:fs';
import path from 'node:path';
import { Zetaris } from '../clients/zetaris.ts';
import { failure, readJson, ROOT, SafeError, setTraceRun, stamp, writeJson } from '../runtime.ts';

export const remainingU1Tables = ['taxi_trips','trips','zones','weather_data','surge_pricing'];
const travelTables = new Set(['taxi_trips','trips','fhv','for_hire_vehicles','green_taxi']);
export function assertU1ContinuationSql(sql:string) {
  const model='lightning\\.metastore\\.concordia_u1\\.u1_usl';
  if (!new RegExp(`^(?:LOAD USL u1_usl NAMESPACE lightning\\.metastore\\.concordia_u1$|ACTIVATE USL TABLE ${model}\\.[A-Za-z_]+ AS SELECT |SELECT [A-Za-z0-9_, ]+ FROM ${model}\\.[A-Za-z_]+ LIMIT [13]$)`).test(sql) || /\b(?:COMPILE|UPDATE|REMOVE|DROP|JOIN|COUNT\s*\(|ORDER\s+BY|GROUP\s+BY)\b/i.test(sql)) throw new SafeError('FORBIDDEN_U1_CONTINUATION_SQL');
}
export async function resumeU1() {
  const check=readJson('evidence/03b-old-hvv-ui-check.json');
  if(check.runningSqlStatements!==0||check.matchingOperation.state!=='CLOSED'||check.checkedBeforeNewSql!==true)throw new SafeError('PRIOR_HVV_OPERATION_NOT_CONFIRMED_TERMINAL');
  const prior=readJson('out/U1/usl-complete.json');
  const checkpoint='.concordia/03b-U1-continuation.json';
  if(fs.existsSync(path.join(ROOT,checkpoint)))throw new SafeError('CONTINUATION_ALREADY_STARTED_INSPECT_CHECKPOINT_NO_BLIND_REPLAY');
  const runId='03b-U1-'+stamp(),dir='evidence/runs/'+runId,tracePath=path.join(ROOT,'evidence/trace.jsonl');
  const offset=fs.readFileSync(tracePath,'utf8').length,budget=readJson('.concordia/budget.json');
  const result:any={runId,utc:new Date().toISOString(),status:'IN_PROGRESS',authority:'ENCARGO_03b_CONCORDIA_D2_CONTINUACION.md',oldQueryCheck:'evidence/03b-old-hvv-ui-check.json',budgetBefore:budget.consumed,steps:[],tables:prior.plans.map((p:any)=>({name:p.name,compiled:true,activated:prior.steps.some((s:any)=>s.stage==='activate_'+p.name),verified:prior.steps.some((s:any)=>s.stage==='verify_'+p.name),verificationLimit:prior.steps.some((s:any)=>s.stage==='verify_'+p.name)?3:null,excluded:p.name==='hvv',exclusionReason:p.name==='hvv'?'Leader decision: exclude hvv from accepted U1 USL by size/cost; leave compiled/activated model unchanged':null}))};
  writeJson(checkpoint,result);setTraceRun(runId);const z=new Zetaris();
  const save=()=>{writeJson(checkpoint,result);writeJson('out/U1/usl-continuation-03b.json',result);};
  const execute=async(stage:string,sql:string,limit:number,timeoutMs=60_000)=>{
    assertU1ContinuationSql(sql);result.lastAttempt={stage,sql,timeoutMs};save();
    const response=await z.runSql(sql,limit,{timeoutMs});result.steps.push({stage,timeoutMs,...response});delete result.lastAttempt;save();return response;
  };
  try {
    const live=await execute('load_existing_model','LOAD USL u1_usl NAMESPACE lightning.metastore.concordia_u1',1);
    const models=live.rows.flat().filter((v:any)=>typeof v==='string').flatMap((v:any)=>{try{return [JSON.parse(v)];}catch{return [];}});
    const model=models.find((v:any)=>Array.isArray(v.tables));
    if(!model||model.tables.map((t:any)=>t.name).sort().join(',')!==prior.plans.map((t:any)=>t.name).sort().join(','))throw new SafeError('COMPILED_U1_MODEL_DRIFT');
    writeJson(dir+'/model-observed.json',model);
    const hvv=result.tables.find((t:any)=>t.name==='hvv'),hvvPlan=prior.plans.find((p:any)=>p.name==='hvv');
    result.hvvRetry={status:'SENT',maximumAttempts:1,timeoutMs:120_000,limit:1};save();
    const start=performance.now();
    try {
      const response=await execute('single_hvv_limit1',`SELECT ${hvvPlan.columns.join(', ')} FROM ${prior.fullModel}.hvv LIMIT 1`,1,120_000);
      if(!response.rows.length)throw new SafeError('HVV_EMPTY_VERIFICATION');
      hvv.verified=true;hvv.verificationLimit=1;result.hvvRetry.status='PASS';result.hvvRetry.durationMs=Math.round(performance.now()-start);
    }catch(error){result.hvvRetry.status='FAIL';result.hvvRetry.error=failure(error);result.hvvRetry.durationMs=Math.round(performance.now()-start);hvv.readConfirmed=false;}
    save();
    for(const name of remainingU1Tables) {
      const table=result.tables.find((t:any)=>t.name===name),plan=prior.plans.find((p:any)=>p.name===name);
      if(!table||!plan)throw new SafeError('REMAINING_TABLE_NOT_IN_COMPILED_PLAN');
      const started=performance.now();
      try {
        await execute('activate_'+name,`ACTIVATE USL TABLE ${prior.fullModel}.${name} AS ${plan.activation}`,1);
        table.activated=true;save();
        const response=await execute('verify_'+name,`SELECT ${plan.columns.join(', ')} FROM ${prior.fullModel}.${name} LIMIT 3`,3);
        if(!response.rows.length)throw new SafeError('EMPTY_USL_VERIFICATION');
        table.verified=true;table.verificationLimit=3;table.durationMs=Math.round(performance.now()-started);save();console.log('PASS U1',name);
      }catch(error){
        table.error=failure(error);table.durationMs=Math.round(performance.now()-started);
        if(travelTables.has(name)&&table.error.code==='TIMEOUT'){table.excluded=true;table.exclusionReason='03b delegated cost exclusion after one 60-second timeout';save();console.log('EXCLUDED_COST U1',name);}
        else throw error;
      }
    }
    if(!result.tables.filter((t:any)=>['yellow_taxi','taxi_zones','zones'].includes(t.name)).every((t:any)=>t.activated&&t.verified))throw new SafeError('U1_MINIMUM_REQUIRED_TABLES_NOT_VERIFIED');
    result.status='PASS_WITH_AUTHORIZED_COST_EXCLUSIONS';
  }catch(error){result.status='BLOCKED';result.error=failure(error);process.exitCode=1;}
  finally {
    result.budgetAfter=readJson('.concordia/budget.json').consumed;result.generations=0;save();
    writeJson(dir+'/continuation.json',result);writeJson(dir+'/receipts.json',[]);
    fs.writeFileSync(path.join(ROOT,dir,'trace.jsonl'),fs.readFileSync(tracePath,'utf8').slice(offset));setTraceRun();
    if(result.status==='BLOCKED')fs.appendFileSync(path.join(ROOT,'docs/reportes/REPORTE_D2.md'),'\n## Bloqueo de continuación 03b U1\n\n'+JSON.stringify(result.error)+'\nEvidencia: out/U1/usl-continuation-03b.json. Sin reenvío completo ni reintentos automáticos.\n');
  }
  console.log(JSON.stringify({status:result.status,hvv:result.hvvRetry,tables:result.tables},null,2));return result;
}
