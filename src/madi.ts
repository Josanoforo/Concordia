// Config-driven schema correspondence; gold is opened only by evaluateMadi.
import fs from 'node:fs';
import path from 'node:path';
import { Zetaris, identifier } from './clients/zetaris.ts';
import { ROOT, readJson, writeJson, SafeError } from './runtime.ts';
import { universeConfig } from './universe-pipeline.ts';
import { quotedValues } from './universe.ts';
export function predictColumn(column:string,description:string,patterns:Record<string,string>,targets:string[]) {
  const text=(column.replaceAll('_',' ')+' '+description).toLowerCase();
  const matches=targets.filter(target=>patterns[target]&&new RegExp(patterns[target],'i').test(text));
  return {target:matches.length===1?matches[0]:null,matches,rule:matches.length===1?'unique_metadata_concept':'ambiguous_or_unknown_metadata'};
}
export async function discoverMappings(id='U3') {
  const cfg=universeConfig(id),z=new Zetaris(),target=readJson(cfg.localInput+'/'+cfg.targetSchema);
  const registrationFile=`.concordia/${id}/registration.json`;
  if(!fs.existsSync(path.join(ROOT,registrationFile)))throw new SafeError('MADI_NOT_REGISTERED_RUN_REGISTER');
  const registration=readJson(registrationFile),excluded=registration.excluded??[];
  const result:any={utc:new Date().toISOString(),live:true,universe:id,kind:cfg.kind,tables:{},candidates:[],errors:[],excluded,privacyExcluded:cfg.privacyExcluded,usesGold:false};
  for(const [table,spec] of Object.entries<any>(cfg.tables)) {
    if(excluded.includes(table))continue;
    const metadata=await z.describe(cfg.database,table);
    const columns=spec.columns.map((c:any)=>identifier(c.name));
    if(columns.some((c:string)=>!metadata.rows.some(r=>r[0]===c)))throw new SafeError('MADI_COLUMN_NOT_PRESENT');
    const sample=await z.runSql(`SELECT ${columns.length?columns.join(', '):'1 AS row_present'} FROM ${identifier(cfg.database)}.${identifier(table)} LIMIT 20`,20);
    result.tables[table]={columns:columns.length?columns:['row_present'],schema:spec.columns,sample,labels:spec.labels,keyColumns:spec.keyColumns,role:spec.role};
    const sourceMeta=readJson(cfg.localInput+'/'+spec.metadata);
    for(const column of spec.columns){
      const m=sourceMeta.variableMeasured.find((x:any)=>x.name===column.name);
      const prediction=predictColumn(column.name,m?.description??'',cfg.conceptPatterns,Object.keys(target.properties));
      result.candidates.push({id:`${table}.${column.name}__${cfg.targetDataset}.${prediction.target??'unknown'}`,from:{db:cfg.database,table,column:column.name},to:{db:'target_schema',table:cfg.targetDataset,column:prediction.target??'unknown'},...prediction,proposedBy:'metadata-heuristic',targetType:target.properties[prediction.target??'']?.type??null});
    }
    console.log('PASS discover',id,table,sample.rows.length,'rows;',columns.length,'allowlisted columns');
  }
  writeJson(`out/${id}/discovery.json`,result);return result;
}
export async function probeMappings(id='U3') {
  const cfg=universeConfig(id),inventory=readJson(`out/${id}/discovery.json`),thresholds=readJson('config/thresholds.json'),z=new Zetaris();
  const probes:any[]=[],relations:any[]=[];
  for(const c of inventory.candidates){
    const t=inventory.tables[c.from.table],index=t.columns.indexOf(c.from.column);
    const values=[...new Set<any>(t.sample.rows.map((r:any[])=>r[index]).filter((v:any)=>v!==null&&String(v).trim()!==''))].slice(0,20);
    const queries:any[]=[];
    if(c.target&&values.length)queries.push(await z.runSql(`SELECT ${identifier(c.from.column)} FROM ${identifier(c.from.db)}.${identifier(c.from.table)} WHERE ${identifier(c.from.column)} IN (${quotedValues(values)}) LIMIT 50`,50));
    const observed=queries.flatMap(q=>q.rows.map((r:any[])=>r[0])).filter(v=>v!==null&&String(v).trim()!=='');
    // A semantic mapping is not an equality join. Numeric sources may require
    // unit normalization; do not silently equate income and revenue.
    const numeric=observed.every(v=>/^[-+]?[0-9]+(?:[.][0-9]+)?$/.test(String(v).trim().replaceAll(',','')));
    const compatible=c.targetType==='integer'?numeric:c.targetType==='array'?false:observed.every(v=>typeof v==='string'||typeof v==='number');
    const supported=Boolean(c.target&&values.length>=thresholds.minDistinctKeys&&observed.length&&compatible);
    const evidence={relation:c,utc:new Date().toISOString(),status:'PASS',kind:'schema-correspondence',queries,usesGold:false,
      overlap:{matched:0,probed:values.length,ratio:null,sampleKeys:[]},
      semanticEvidence:{uniqueConcept:c.target,observedRows:observed.length,targetType:c.targetType,rule:c.rule},
      typeCompat:{from:'source string',to:c.targetType,castable:compatible,normalization:'schema mapping only; numeric unit conversion not executed'},alerts:[],nullRate:{from:t.sample.rows.length?t.sample.rows.filter((row:any[])=>row[index]==null||String(row[index]).trim()==='').length/t.sample.rows.length:null}};
    probes.push(evidence);
    relations.push({relationId:c.id,from:c.from,to:c.to,verdict:supported?'SOSTENIDA':'INDETERMINADA',rule:supported?'unique_metadata_concept_and_bounded_type_evidence':'unknown_ambiguous_or_insufficient_evidence',kind:'schema-correspondence',proposedBy:c.proposedBy,evidence,explanation:`${supported?'SOSTENIDA':'INDETERMINADA'}: concepto ${c.target??'no identificable de forma única'}; ${values.length} valores distintos en muestra; ${observed.length} filas sondeadas; tipos compatibles=${compatible}. Correspondencia semántica, no FK, identidad empresarial ni igualdad de valores; sin gold y sin transformación monetaria.`});
  }
  const result={utc:new Date().toISOString(),live:true,usesGold:false,pending_llm:false,relations};
  writeJson(`out/${id}/probes.json`,{utc:result.utc,probes});writeJson(`out/${id}/relaciones.json`,result);
  return result;
}
export type Mapping={source_dataset:string;source_column:string;target_dataset:string;target_column:string};
const key=(m:Mapping)=>JSON.stringify([m.source_dataset,m.source_column,m.target_dataset,m.target_column]);
export function mappingMetrics(predictions:Mapping[],gold:Mapping[]){
  const predicted=new Map(predictions.map(m=>[key(m),m])),expected=new Map(gold.map(m=>[key(m),m]));
  const tp=[...predicted.keys()].filter(k=>expected.has(k)),fp=[...predicted.keys()].filter(k=>!expected.has(k)),fn=[...expected.keys()].filter(k=>!predicted.has(k));
  return {truePositives:tp.length,falsePositiveCount:fp.length,falseNegativeCount:fn.length,predicted:predicted.size,gold:expected.size,precision:predicted.size?tp.length/predicted.size:null,recall:expected.size?tp.length/expected.size:null,falsePositives:fp.map(k=>predicted.get(k)),falseNegatives:fn.map(k=>expected.get(k))};
}
export function evaluateMadi(id='U3') {
  const cfg=universeConfig(id),relations=readJson(`out/${id}/relaciones.json`).relations;
  const gold=readJson(cfg.localInput+'/'+cfg.gold);
  // Validate the actual published format, never infer silently from values.
  const goldRows=Array.isArray(gold)?gold:gold.mappings;
  if(!Array.isArray(goldRows)||!goldRows.every((g:any)=>typeof g.source_dataset==='string'&&typeof g.source_column==='string'&&typeof g.target_dataset==='string'&&typeof g.target_column==='string'))throw new SafeError('MADI_GOLD_FORMAT_NOT_SUPPORTED');
  const predictions=relations.filter((r:any)=>r.verdict==='SOSTENIDA').map((r:any)=>({source_dataset:r.from.table,source_column:r.from.column,target_dataset:cfg.targetDataset,target_column:r.to.column}));
  const result={utc:new Date().toISOString(),status:'MEASURED',universe:id,scope:'Column correspondences, full published gold including privacy-excluded fields; not entity matching, fusion, normalization or FK accuracy',...mappingMetrics(predictions,goldRows)};
  writeJson(`out/${id}/eval.json`,result);console.log('Eval',id,JSON.stringify(result));return result;
}
