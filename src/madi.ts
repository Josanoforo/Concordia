// Config-driven schema correspondence; gold is opened only by evaluateMadi.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Zetaris, identifier } from './clients/zetaris.ts';
import { ROOT, readJson, writeJson, SafeError } from './runtime.ts';
import { universeConfig } from './universe-pipeline.ts';
import { quotedValues } from './universe.ts';
export type MetadataAliasRule={
  sourceDataset:string; sourceColumn:string; decision:'approved'|'abstain'; targetColumn?:string;
  sourceDescriptionPattern?:string; sourceType?:string; targetType?:string; reason:string;
  provenance:{sourceMetadata:string;targetSchema:string;vocabulary?:string;term?:string;review:string};
};
export type MetadataAliasContext={dataset?:string;sourceType?:string;targetTypes?:Record<string,string>;targetDescriptions?:Record<string,string>;aliasRules?:MetadataAliasRule[];aliasVersion?:string};
export type ColumnPrediction={target:string|null;matches:string[];rule:string;reason:string;aliasProvenance:Record<string,unknown>};
export function predictColumn(column:string,description:string,patterns:Record<string,string>,targets:string[],context:MetadataAliasContext={}):ColumnPrediction {
  const scoped=(context.aliasRules??[]).filter(rule=>rule.sourceColumn===column&&(!context.dataset||rule.sourceDataset===context.dataset));
  if(scoped.length>1)return {target:null,matches:[],rule:'ambiguous_alias_registry',reason:'multiple reviewed alias rules apply',aliasProvenance:{version:context.aliasVersion??null,rules:scoped}};
  const reviewed=scoped[0];
  if(reviewed){
    const provenance={version:context.aliasVersion??null,...reviewed.provenance,decision:reviewed.decision,reason:reviewed.reason};
    if(reviewed.decision==='abstain')return {target:null,matches:[],rule:'reviewed_metadata_abstention',reason:reviewed.reason,aliasProvenance:provenance};
    const descriptionMatches=Boolean(reviewed.sourceDescriptionPattern&&new RegExp(reviewed.sourceDescriptionPattern,'i').test(description));
    if(!descriptionMatches)return {target:null,matches:[],rule:'alias_description_mismatch',reason:'source metadata does not satisfy the reviewed description condition',aliasProvenance:provenance};
    if(reviewed.sourceType&&context.sourceType!==reviewed.sourceType)return {target:null,matches:[],rule:'alias_source_type_mismatch',reason:'source type differs from the reviewed alias contract',aliasProvenance:provenance};
    if(reviewed.targetType&&context.targetTypes?.[reviewed.targetColumn??'']!==reviewed.targetType)return {target:null,matches:[],rule:'alias_target_type_mismatch',reason:'target type differs from the reviewed alias contract',aliasProvenance:provenance};
    if(!reviewed.targetColumn||!targets.includes(reviewed.targetColumn))return {target:null,matches:[],rule:'alias_target_unavailable',reason:'reviewed target is absent from target schema',aliasProvenance:provenance};
    return {target:reviewed.targetColumn,matches:[reviewed.targetColumn],rule:'approved_metadata_alias',reason:reviewed.reason,aliasProvenance:provenance};
  }
  const text=(column.replaceAll('_',' ')+' '+description).toLowerCase();
  const matches=targets.filter(target=>patterns[target]&&new RegExp(patterns[target],'i').test(text));
  const provenance={version:context.aliasVersion??null,source:'universes/U3_madi_companies.json#conceptPatterns',decision:'unreviewed_pattern'};
  if(matches.length!==1)return {target:null,matches,rule:'ambiguous_or_unknown_metadata',reason:'no unique configured concept pattern',aliasProvenance:provenance};
  const matched=matches[0],targetType=context.targetTypes?.[matched];
  if(context.sourceType&&targetType&&context.sourceType!==targetType)return {target:null,matches,rule:'metadata_type_mismatch',reason:'source and target schema types differ; no value-based cast is allowed',aliasProvenance:provenance};
  const targetDescription=context.targetDescriptions?.[matched]??'';
  const unitRequired=/\b(?:usd|u\.s\.\s*dollars?)\b|US\$/i.test(targetDescription);
  const requiredPeriods=[...targetDescription.matchAll(/\b(?:19|20)\d{2}\b/g)].map(match=>match[0]);
  if(unitRequired||requiredPeriods.length){
    const unitKnown=/\b(?:usd|u\.s\.\s*dollars?)\b|US\$/i.test(description);
    const periodKnown=requiredPeriods.every(period=>new RegExp(`\\b${period}\\b`).test(description));
    if((unitRequired&&!unitKnown)||!periodKnown)return {target:null,matches,rule:'metadata_unit_or_period_missing',reason:'source metadata does not declare the target-required unit and temporal scope',aliasProvenance:provenance};
  }
  return {target:matched,matches,rule:'unique_metadata_concept',reason:'unique configured concept pattern with compatible declared type and required measure metadata',aliasProvenance:provenance};
}
export function auditMadiAliases(){
  const cfg=universeConfig('U3'),target=readJson(cfg.localInput+'/'+cfg.targetSchema),catalog=readJson<any>('config/madi-aliases.json');
  const catalogSha256=createHash('sha256').update(fs.readFileSync(path.join(ROOT,'config/madi-aliases.json'))).digest('hex');
  const targetTypes=Object.fromEntries(Object.entries<any>(target.properties).map(([name,value])=>[name,value.type]));
  const targetDescriptions=Object.fromEntries(Object.entries<any>(target.properties).map(([name,value])=>[name,value.description??'']));
  const sourceMetadataHashes:any={},decisions:any[]=[];
  for(const [table,spec] of Object.entries<any>(cfg.tables)){
    if(!spec.columns.length)continue;
    const metadataPath=cfg.localInput+'/'+spec.metadata,metadata=readJson(metadataPath);
    sourceMetadataHashes[metadataPath]=createHash('sha256').update(fs.readFileSync(path.join(ROOT,metadataPath))).digest('hex');
    for(const column of spec.columns){
      const description=metadata.variableMeasured.find((x:any)=>x.name===column.name)?.description??'';
      const prediction=predictColumn(column.name,description,cfg.conceptPatterns,Object.keys(target.properties),{dataset:table,sourceType:column.type,targetTypes,targetDescriptions,aliasRules:catalog.rules,aliasVersion:catalog.version});
      decisions.push({source:{dataset:table,column:column.name},target:prediction.target,decision:prediction.target?'candidate':'abstain',rule:prediction.rule,reason:prediction.reason,aliasProvenance:prediction.aliasProvenance});
    }
  }
  const result={status:'FROZEN_BEFORE_EVALUATION',utc:new Date().toISOString(),universe:'U3',usesGold:false,usesSourceValues:false,usesNetwork:false,registry:{version:catalog.version,sha256:catalogSha256,source:'config/madi-aliases.json',frozenBeforeEvaluation:catalog.frozenBeforeEvaluation},targetSchemaSha256:createHash('sha256').update(fs.readFileSync(path.join(ROOT,cfg.localInput,cfg.targetSchema))).digest('hex'),sourceMetadataHashes,summary:{candidates:decisions.filter(d=>d.decision==='candidate').length,abstentions:decisions.filter(d=>d.decision==='abstain').length},decisions};
  writeJson('out/U3/alias-audit.json',result);return result;
}
export async function discoverMappings(id='U3') {
  const cfg=universeConfig(id),z=new Zetaris(),target=readJson(cfg.localInput+'/'+cfg.targetSchema);
  const aliasCatalog=readJson<any>('config/madi-aliases.json'),aliasSha256=createHash('sha256').update(fs.readFileSync(path.join(ROOT,'config/madi-aliases.json'))).digest('hex');
  const registrationFile=`.concordia/${id}/registration.json`;
  if(!fs.existsSync(path.join(ROOT,registrationFile)))throw new SafeError('MADI_NOT_REGISTERED_RUN_REGISTER');
  const registration=readJson(registrationFile),excluded=registration.excluded??[];
  const result:any={utc:new Date().toISOString(),live:true,universe:id,kind:cfg.kind,tables:{},candidates:[],errors:[],excluded,privacyExcluded:cfg.privacyExcluded,usesGold:false,metadataAliasRegistry:{version:aliasCatalog.version,sha256:aliasSha256,frozenBeforeEvaluation:aliasCatalog.frozenBeforeEvaluation,usesSourceValues:false}};
  const targetTypes=Object.fromEntries(Object.entries<any>(target.properties).map(([name,value])=>[name,value.type]));
  const targetDescriptions=Object.fromEntries(Object.entries<any>(target.properties).map(([name,value])=>[name,value.description??'']));
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
      const prediction=predictColumn(column.name,m?.description??'',cfg.conceptPatterns,Object.keys(target.properties),{dataset:table,sourceType:column.type,targetTypes,targetDescriptions,aliasRules:aliasCatalog.rules,aliasVersion:aliasCatalog.version});
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
