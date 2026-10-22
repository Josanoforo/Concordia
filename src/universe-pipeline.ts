// Configuration-driven bounded pipeline. Adding an input universe changes only
// its JSON contract; normalization and SQL policy are common engine behavior.
import fs from 'node:fs';
import path from 'node:path';
import { Zetaris, identifier } from './clients/zetaris.ts';
import { classify } from './probe/verdicts.ts';
import { normalizeKey as normalizeByMode, quotedValues, type NormalizationMode } from './universe.ts';
import { readJson, writeJson, ROOT, failure, SafeError } from './runtime.ts';

export function universeConfig(id:string) { if(!/^U[123]$/.test(id))throw new SafeError('INVALID_UNIVERSE'); return readJson(`universes/${id==='U1'?'U1_ny_taxi':id==='U3'?'U3_madi_companies':'U2_companies'}.json`); }
export function normalizeKey(value:unknown,mode:NormalizationMode,contract:any) {
  if(!contract?.modes?.[mode])throw new SafeError('NORMALIZATION_NOT_DECLARED_FOR_UNIVERSE');
  return normalizeByMode(value,mode);
}
function baseQuery(spec:any) {
  if(spec.baseSql) {
    if(!/^SELECT\s/i.test(spec.baseSql)||/;|\b(?:JOIN|COUNT\s*\(|ORDER\s+BY|GROUP\s+BY)\b/i.test(spec.baseSql)||/SELECT\s+\*/i.test(spec.baseSql))throw new SafeError('UNSAFE_UNIVERSE_BASE_QUERY');
    return spec.baseSql;
  }
  return `SELECT ${spec.columns.map((c:any)=>identifier(c.name)).join(', ')} FROM ${identifier(spec.db)}.${identifier(spec.physicalTable)}`;
}
export const sourceQuery=(spec:any)=>'('+baseQuery(spec)+') concordia_source';
export async function discoverUniverse(id:string) {
  const cfg=universeConfig(id),z=new Zetaris();
  const result:any={utc:new Date().toISOString(),live:true,pending_llm:false,llm:'deterministic configured candidates; no generation needed',tables:{},candidates:cfg.relations,errors:[]};
  for(const [name,spec] of Object.entries<any>(cfg.tables)) {
    try {
      const metadata=await z.describe(spec.db,spec.physicalTable);
      const projection=spec.columns.map((c:any)=>identifier(c.name));
      if(!spec.baseSql && projection.some((c:string)=>!metadata.rows.some(r=>r[0]===c)))throw new SafeError('U2_ALLOWLIST_COLUMN_MISSING');
      const sample=await z.runSql(`SELECT ${projection.join(', ')} FROM ${sourceQuery(spec)} LIMIT 20`,20);
      result.tables[name]={columns:projection,schema:spec.columns,sourceMetadata:metadata,derivedSchema:Boolean(spec.baseSql),sample,labels:spec.labels??[],keyColumns:spec.keyColumns,role:spec.role};
      console.log('PASS discover',id,name,sample.rows.length);
    }catch(error){result.errors.push({table:name,...failure(error)});break;}
  }
  writeJson(`out/${id}/discovery.json`,result);
  if(result.errors.length)throw new SafeError('UNIVERSE_DISCOVERY_BLOCKED',undefined,JSON.stringify(result.errors));
  return result;
}
export async function probeUniverse(id:string) {
    const cfg=universeConfig(id),inventory=readJson(`out/${id}/discovery.json`),z=new Zetaris(),thresholds=readJson('config/thresholds.json');
  const result:any={utc:new Date().toISOString(),live:true,probes:[]};
  for(const relation of cfg.relations) {
    const a=inventory.tables[relation.from.table],b=inventory.tables[relation.to.table], mode=relation.normalization;
    const values=a.sample.rows.map((row:any[])=>row[a.columns.indexOf(relation.from.column)]).filter((v:any)=>v!=null);
    const seeds=[...new Set(values.map((v:any)=>normalizeKey(v,mode,cfg.normalizationContract)))].filter(v=>v!==null);
    const variants=mode==='integer-pad10'?[...values,...seeds,...seeds.map(v=>String(v).padStart(10,'0'))]:values;
    const queries:any[]=[];
    for(const endpoint of [relation.from,relation.to]) {
      const spec=cfg.tables[endpoint.table];
      if(!spec.columns.some((c:any)=>c.name===endpoint.column))throw new SafeError('PROBE_KEY_OUTSIDE_ALLOWLIST');
      queries.push(await z.runSql(`SELECT ${identifier(endpoint.column)} FROM ${sourceQuery(spec)} WHERE ${identifier(endpoint.column)} IN (${quotedValues([...new Set(variants)].slice(0,50))}) LIMIT 50`,50));
    }
    const targets=new Set(queries[1].rows.map((row:any[])=>normalizeKey(row[0],mode,cfg.normalizationContract)));
    const matched=seeds.filter(k=>targets.has(k)).length;
    const probe:any={relation,utc:new Date().toISOString(),status:'PASS',queries,normalization:mode,overlap:{matched,probed:seeds.length,ratio:seeds.length?matched/seeds.length:null,sampleKeys:seeds},
      typeCompat:{from:a.schema.find((c:any)=>c.name===relation.from.column).type,to:b.schema.find((c:any)=>c.name===relation.to.column).type,castable:true,normalization:mode},
      nullRate:{from:a.sample.rows.filter((row:any[])=>row[a.columns.indexOf(relation.from.column)]==null).length/a.sample.rows.length,to:b.sample.rows.filter((row:any[])=>row[b.columns.indexOf(relation.to.column)]==null).length/b.sample.rows.length},alerts:[]};
    result.probes.push(probe); writeJson(`out/${id}/probes.json`,result);
  }
  const output:any={utc:new Date().toISOString(),pending_llm:false,explanationSource:'deterministic-template',relations:result.probes.map((p:any)=>{
    const decision=classify(p,{...thresholds,minDistinctKeys:p.relation.minDistinctKeys??thresholds.minDistinctKeys});
    return {relationId:p.relation.id,from:p.relation.from,to:p.relation.to,...decision,evidence:p,normalization:p.normalization,explanation:`${decision.verdict}: ${p.overlap.matched}/${p.overlap.probed} claves de la muestra; comparación ${p.normalization}. Sin prueba de cobertura global.`,proposedBy:'heuristic-configured'};
  })};
  writeJson(`out/${id}/relaciones.json`,output);
  fs.writeFileSync(path.join(ROOT,`out/${id}/relaciones.md`),['# Relaciones '+id,'','Sin generación. Comparaciones de muestras acotadas, no uniones remotas.','',...output.relations.map((r:any)=>`- ${r.relationId}: ${r.explanation}`)].join('\n')+'\n');
  return output;
}
export function evaluateUniverse(id:string) {
  const cases=readJson(`eval/cases/${id}.json`),relations=readJson(`out/${id}/relaciones.json`).relations;
  const results=cases.cases.map((c:any)=>{const r=relations.find((r:any)=>r.relationId===c.relationId);return {id:c.id,expected:c.expected,actual:r?.verdict??'NOT_FOUND',pass:Boolean(r&&c.expected.includes(r.verdict))};});
  const correct=results.filter((r:any)=>r.pass).length,result={utc:new Date().toISOString(),status:correct>=cases.minCorrect?'PASS':'FAIL',correct,total:results.length,results};
  writeJson(`out/${id}/eval.json`,result); if(result.status!=='PASS')throw new SafeError('UNIVERSE_EVAL_FAILED'); console.log(JSON.stringify(result)); return result;
}
