import { Zetaris } from '../clients/zetaris.ts';
import { buildCompleteUsl } from './complete.ts';
import { failure, readJson, SafeError, writeJson } from '../runtime.ts';
export function verificationTable(id:string,plans:any[]) {
  const name=id==='U1'?'zones':id==='U2'?'sic_reference':undefined;
  if(!name)throw new SafeError('USL_UNIVERSE_NOT_AUTHORIZED');
  const table=plans.find(t=>t.name===name);
  if(!table)throw new SafeError('USL_VERIFICATION_TABLE_MISSING',undefined,name);
  return table;
}
export async function demoUsl(id:string,client?:Pick<Zetaris,'runSql'>):Promise<any> {
  if(id==='U3')return {status:'OPTIONAL_DEFERRED',reason:'Schema correspondences are not referential keys. No invented FK/PK; U3 gold evaluation takes precedence.'};
  const plan=buildCompleteUsl(id,readJson(`out/${id}/relaciones.json`).relations),z=client??new Zetaris();
  let existing:any;
  try{existing=await z.runSql(`LOAD USL ${plan.model} NAMESPACE ${plan.namespace}`,1);}
  catch(error){
    const f=failure(error);
    // Only an explicit missing model/namespace authorizes a new deployment.
    // Network/auth/parser errors must never be interpreted as absence.
    if(!/\b(?:usl|namespace|model)\b/i.test(f.detail??'')||!/\b(?:not exist(?:ing)?|not found|does not exist)\b/i.test(f.detail??''))throw error;
  }
  const steps:any[]=[];
  if(existing){
    const model=existing.rows.flat().map((s:unknown)=>{try{return JSON.parse(String(s));}catch{return null;}}).find((m:any)=>m?.tables);
    if(!model)throw new SafeError('EXISTING_USL_UNRECOGNIZED_NO_REPLACEMENT');
    const missing=plan.plans.filter(t=>!model.tables.some((m:any)=>m.name===t.name));
    if(missing.length)throw new SafeError('EXISTING_USL_MISSING_TABLES_NO_RECOMPILE',undefined,missing.map(t=>t.name).join(','));
    // Confirm a small, previously fast activated dimension; never query hvv.
    const table=verificationTable(id,plan.plans);
    steps.push(await z.runSql(`SELECT ${table.columns.join(', ')} FROM ${plan.fullModel}.${table.name} LIMIT 3`,3));
    const result={utc:new Date().toISOString(),status:'REUSED_EXISTING',model:plan.fullModel,modelDetails:model,loadRequestId:existing.requestId,tables:plan.plans.map(t=>t.name),verifiedNow:table.name,steps,
      priorVerification:'D2: U1 eight tables / U2 three; dates in out/<U>/usl-complete.json and U1/usl-continuation-03b.json',costExcluded:id==='U1'?['hvv']:[],recompiled:false};
    return result;
  }
  for(const sql of ['CREATE NAMESPACE IF NOT EXISTS lightning.metastore',`CREATE NAMESPACE IF NOT EXISTS ${plan.namespace}`,`COMPILE USL IF NOT EXISTS ${plan.model} DEPLOY NAMESPACE ${plan.namespace} DDL\n${plan.ddl}`])steps.push(await z.runSql(sql,1));
  for(const table of plan.plans){
    if(id==='U1'&&table.name==='hvv')continue;
    steps.push(await z.runSql(`ACTIVATE USL TABLE ${plan.fullModel}.${table.name} AS ${table.activation}`,1));
    steps.push(await z.runSql(`SELECT ${table.columns.join(', ')} FROM ${plan.fullModel}.${table.name} LIMIT 3`,3));
  }
  const result={utc:new Date().toISOString(),status:'NEW_MODEL',model:plan.fullModel,steps,recompiled:false,costExcluded:id==='U1'?['hvv']:[]};
  return result;
}
