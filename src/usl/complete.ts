import fs from 'node:fs';
import path from 'node:path';
import { Zetaris, identifier } from '../clients/zetaris.ts';
import { universe } from '../universe.ts';
import { sourceQuery, universeConfig } from '../universe-pipeline.ts';
import { readJson, writeJson, ROOT, failure, SafeError, stamp, setTraceRun } from '../runtime.ts';

const numericKey=(column:string)=>`CASE WHEN CAST(${column} AS STRING) RLIKE '^-?[0-9]+([.]0+)?$' THEN CAST(CAST(${column} AS DECIMAL(38,0)) AS STRING) ELSE CAST(${column} AS STRING) END`;
export function buildCompleteUsl(id:string,relations:any[]) {
  if(!['U1','U2'].includes(id))throw new SafeError('USL_UNIVERSE_NOT_AUTHORIZED');
  const cfg=id==='U1'?universe():universeConfig(id);
  const supported=relations.filter(r=>r.verdict==='SOSTENIDA'); if(!supported.length)throw new SafeError('USL_NO_SUPPORTED_RELATIONS');
  const tables=[...new Set<string>(supported.flatMap(r=>[r.from.table,r.to.table]))];
  const primary=new Map<string,string>();
  for(const r of supported){if(primary.has(r.to.table)&&primary.get(r.to.table)!==r.to.column)throw new SafeError('MULTIPLE_UNPROVEN_PRIMARY_KEYS');primary.set(r.to.table,r.to.column);}
  const mappings:any[]=[];
  const plans=tables.map(name=>{
    identifier(name); const spec=cfg.tables[name]; if(!spec)throw new SafeError('USL_TABLE_OUTSIDE_ALLOWLIST');
    const columns=spec.columns.map((c:any)=>c.name),definitions:string[]=[],projections:string[]=[],emitted:string[]=[];
    for(const column of columns) {
      identifier(column);
      const edges=supported.filter(r=>r.from.table===name&&r.from.column===column);
      const key=primary.get(name)===column||edges.length>0;
      const value=key?numericKey(column):`CAST(${column} AS STRING)`;
      const expression=primary.get(name)===column?`COALESCE(${value}, '')`:value;
      definitions.push(`  ${column} varchar(512)${primary.get(name)===column?' NOT NULL PRIMARY KEY':''}${edges[0]?` FOREIGN KEY REFERENCES ${identifier(edges[0].to.table)}(${identifier(edges[0].to.column)})`:''}`);
      projections.push(`${expression} AS ${column}`);emitted.push(column);
      if(edges[0])mappings.push({relationId:edges[0].relationId,sourceColumn:column,uslColumn:column,target:edges[0].to});
      for(const [i,edge]of edges.slice(1).entries()) {
        const alias=identifier(column+'__fk_'+(i+2));
        if(columns.includes(alias))throw new SafeError('DERIVED_USL_ALIAS_COLLISION');
        definitions.push(`  ${alias} varchar(512) FOREIGN KEY REFERENCES ${identifier(edge.to.table)}(${identifier(edge.to.column)})`);
        projections.push(`${value} AS ${alias}`);emitted.push(alias);
        mappings.push({relationId:edge.relationId,sourceColumn:column,uslColumn:alias,target:edge.to,reason:'same source key has multiple sustained targets; one documented projection alias per extra inline FK'});
      }
    }
    const pk=primary.get(name),from=id==='U1'?`NY_TAXI.${name}`:sourceQuery(spec);
    const activation=`SELECT ${projections.join(', ')} FROM ${from}${pk?` WHERE ${pk} IS NOT NULL AND TRIM(CAST(${pk} AS STRING)) <> ''`:''}`;
    return {name,columns:emitted,ddl:`CREATE TABLE ${name} (\n${definitions.join(',\n')}\n);`,activation};
  });
  const namespace='lightning.metastore.concordia_'+id.toLowerCase(),model=id.toLowerCase()+'_usl';
  const ddl=plans.map(p=>p.ddl).join('\n');
  return {id,namespace,model,fullModel:namespace+'.'+model,ddl,plans,mappings,supportedIds:supported.map(r=>r.relationId),excluded:relations.filter(r=>r.verdict!=='SOSTENIDA').map(r=>({relationId:r.relationId,verdict:r.verdict,explanation:r.explanation}))};
}
function modelJson(rows:any[][]) {
  for(const row of rows)for(const cell of row)if(typeof cell==='string') {try{const obj=JSON.parse(cell);if(obj?.tables&&obj?.name)return obj;}catch{}}
  throw new SafeError('USL_COMPILED_MODEL_JSON_NOT_FOUND');
}
export async function completeUsl(id:string, options?: { deferDq: boolean }) {
  if (id==='U1' && fs.existsSync(path.join(ROOT,'.concordia/03b-U1-continuation.json'))) throw new SafeError('U1_FULL_MODEL_REPLAY_FORBIDDEN_AFTER_03B_CONTINUATION');
  const relations=readJson(`out/${id}/relaciones.json`).relations, plan=buildCompleteUsl(id,relations),z=new Zetaris();
  const runId='usl-complete-'+id+'-'+stamp(),dir='evidence/runs/'+runId,tracePath=path.join(ROOT,'evidence/trace.jsonl');
  const offset=fs.readFileSync(tracePath,'utf8').length;
  const result:any={utc:new Date().toISOString(),runId,status:'IN_PROGRESS',...plan,steps:[],generations:0};
  setTraceRun(runId);
  const execute=async(stage:string,sql:string,limit=1)=>{result.failedStatement={stage,sql};const r=await z.runSql(sql,limit);result.steps.push({stage,...r});delete result.failedStatement;writeJson(`out/${id}/usl-complete.json`,result);return r;};
  try {
    await execute('namespace',`CREATE NAMESPACE IF NOT EXISTS ${plan.namespace}`);
    if(id==='U1') {
      const backup=await execute('backup_existing',`LOAD USL ${plan.model} NAMESPACE ${plan.namespace}`);
      writeJson(dir+'/model-before.json',modelJson(backup.rows));
      const compiled=await execute('compile_one_payload',`COMPILE USL ${plan.model} NAMESPACE ${plan.namespace} DDL\n${plan.ddl}`);
      await execute('replace_authorized_model',`UPDATE USL ${plan.model} NAMESPACE ${plan.namespace} AS ${JSON.stringify(modelJson(compiled.rows))}`);
    }else await execute('compile_one_payload',`COMPILE USL ${plan.model} DEPLOY NAMESPACE ${plan.namespace} DDL\n${plan.ddl}`);
    for(const table of plan.plans) {
      await execute('activate_'+table.name,`ACTIVATE USL TABLE ${plan.fullModel}.${table.name} AS ${table.activation}`);
      const check=await execute('verify_'+table.name,`SELECT ${table.columns.join(', ')} FROM ${plan.fullModel}.${table.name} LIMIT 3`,3);
      if(!check.rows.length)throw new SafeError('USL_EMPTY_VERIFICATION');
    }
    if (!options?.deferDq) result.dq=await execute('list_generated_dq',`LIST DQ USL ${plan.fullModel}`,50);
    else result.dqDeferred=true;
    result.status='PASS';
  }catch(error){result.status='BLOCKED';result.error=failure(error);process.exitCode=1;}
  finally {
    writeJson(`out/${id}/usl-complete.json`,result);writeJson(dir+'/usl.json',result);writeJson(dir+'/receipts.json',[]);
    fs.writeFileSync(path.join(ROOT,dir,'trace.jsonl'),fs.readFileSync(tracePath,'utf8').slice(offset));setTraceRun();
    const lines=['# USL '+id+' — D2','',`Estado: ${result.status}. Modelo: ${plan.fullModel}.`,'',
      `Todas las SOSTENIDAS: ${plan.supportedIds.length} relaciones; ${plan.plans.length} tablas. Una sola sentencia COMPILE íntegra. U1 se respalda mediante LOAD, compila sin DEPLOY y reemplaza mediante UPDATE USL AS JSON oficial; cada tabla se reactiva porque UPDATE borra la activación efectiva. No se elimina ningún modelo ni se modifica la configuración de Zetaris.`,'',
      'Claves integer-like y .0 se normalizan mediante DECIMAL(38,0) sin redondear valores fraccionarios: el CASE exige forma entera antes del cast. Otros textos se preservan. PKs filtran NULL y vacío antes de COALESCE. Son PKs declaradas sobre dimensiones; las muestras no prueban unicidad global. Si una columna tiene dos FKs se emite un alias de su misma proyección para el segundo destino; no se añade una columna fuente inventada.','',
      '## DDL emitido','','```sql',`COMPILE USL ${plan.model}${id==='U1'?'':' DEPLOY'} NAMESPACE ${plan.namespace} DDL\n${plan.ddl}`,'```','','## Relaciones y alias','',...plan.mappings.map(m=>'- '+JSON.stringify(m)),'','## Exclusiones','',...plan.excluded.map(r=>`- ${r.relationId}: ${r.verdict}. ${r.explanation}`),'','## Activación y comprobaciones',''];
    for(const step of result.steps)lines.push(`- ${step.stage}: requestId=${step.requestId}; filas=${step.rows.length}; ${step.durationMs} ms.`,...(step.stage.startsWith('activate_')?['','```sql',step.sql,'```']:[]));
    lines.push('','## DQ','',result.dq?'LIST DQ ejecutado; reglas/constraints devueltos en out/'+id+'/usl-complete.json, campo dq. No se ejecutó RUN DQ (puede recorrer datos completos), ni se afirma validez global.':'LIST DQ pendiente por bloqueo previo.','REGISTER DQ adicional no ejecutado: no es necesario para leer las reglas FK, y el catálogo documenta dos fallos de esa forma.','',...(result.error?['Error exacto sanitizado: '+JSON.stringify(result.error)]:[]));
    fs.writeFileSync(path.join(ROOT,`docs/USL_${id}.md`),lines.join('\n')+'\n');
    if(result.status==='BLOCKED')fs.appendFileSync(path.join(ROOT,'docs/reportes/REPORTE_D2.md'),`\n## Bloqueo USL ${id}\n\n${JSON.stringify(result.error)}\n\nEvidencia: out/${id}/usl-complete.json. Se detiene la ejecución según sección 0.\n`);
  }
  console.log('USL',id,result.status,'FKs',plan.supportedIds.length,'tables',plan.plans.length,result.error??'');return result;
}
