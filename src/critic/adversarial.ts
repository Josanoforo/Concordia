import path from 'node:path';
import fs from 'node:fs';
import { Zetaris, identifier } from '../clients/zetaris.ts';
import { readJson, writeJson, ROOT, SafeError, trace, failure, setTraceRun, traceFileForRun } from '../runtime.ts';
import { normalizeKey, type NormalizationMode, quotedValues } from '../universe.ts';
import { sourceQuery } from '../universe-pipeline.ts';
import { writeRelations } from '../probe/verdicts.ts';

type Counterprobe = { relationId:string; strategy:string; sql:string; requestId:string; utc:string; rows:any[][]; metrics:any; status:string };
const key = (v:any,mode:NormalizationMode='integer') => normalizeKey(v,mode);
function lastRequestId(file:string){try{const lines=fs.readFileSync(file,'utf8').trimEnd().split(/\r?\n/),last=JSON.parse(lines.at(-1)??'{}');return last.kind==='zetaris'?last.requestId:null;}catch{return null;}}
export function judgeCounterprobe(metrics:any,thresholds:any){
  const reasons:string[]=[];
  if(metrics.duplicateKeys?.length)reasons.push('duplicate_referenced_keys_in_bounded_result');
  if(metrics.labelAgreement&&metrics.labelAgreement.ratio<thresholds.criticLabelAgreementFloor)reasons.push('label_agreement_below_floor');
  if(metrics.overlap!==null&&metrics.overlap<thresholds.criticOverlapFloor)reasons.push('overlap_below_floor');
  if(metrics.sponsor?.metrics?.ratio!==null&&metrics.sponsor?.metrics?.ratio!==undefined&&metrics.sponsor.metrics.ratio<thresholds.criticOverlapFloor)reasons.push('sponsor_reference_overlap_below_floor');
  if(reasons.some(r=>r==='duplicate_referenced_keys_in_bounded_result'||r==='label_agreement_below_floor'))return {status:'DEGRADED',reasons};
  if(metrics.sourceError||metrics.targetTruncated&&metrics.matchedKeys<metrics.seedKeys)return {status:'INSUFFICIENT',reasons};
  if(reasons.length)return {status:'DEGRADED',reasons};
  return {status:'CONFIRMED',reasons};
}

/** Bounded adversarial checks over only already-sustained, non-cost-excluded relations. */
export async function criticize(id='U1',options:{includeExcluded?:boolean;relationIds?:string[];force?:boolean}={}) {
  const runId=`critic-${id}-${new Date().toISOString().replace(/[-:.]/g,'')}`,tracePath=traceFileForRun(runId),traceOffset=fs.existsSync(tracePath)?fs.readFileSync(tracePath,'utf8').length:0;setTraceRun(runId);
  try{
  const cfg=readJson<any>(`universes/${id==='U1'?'U1_ny_taxi':id==='U2'?'U2_companies':'U3_madi_companies'}.json`);
  const relations=readJson<any>(`out/${id}/relaciones.json`),inventory=readJson<any>(`out/${id}/discovery.json`);
  const thresholds=readJson<any>('config/thresholds.json'),excluded=readJson<any>('config/cost-exclusions.json')[id]??[];
  const z=new Zetaris(),prior=relations.critic?.results??[];
  let sponsorAvailable=false;
  if(id==='U2'){
    try{const loaded=await z.runSql('LOAD USL lightning.metastore.usl_demo.sic_edgar_usl',1);sponsorAvailable=true;trace({role:'critic',action:'sponsor_load',universe:id,sql:loaded.sql,requestId:loaded.requestId,result:{rows:loaded.rows.length}});writeJson('evidence/critic-sponsor-load-U2.json',{status:'AVAILABLE',requestId:loaded.requestId,utc:loaded.utc});}
    catch(error){const detail=failure(error);trace({role:'critic',action:'sponsor_unavailable',universe:id,reason:detail});writeJson('evidence/critic-sponsor-load-U2.json',{status:'UNAVAILABLE',error:detail,utc:new Date().toISOString()});}
  }
  const log:any[]=options.force?[]:options.relationIds?.length?prior.filter((x:any)=>!options.relationIds!.includes(x.relationId)):prior;
  for(const r of relations.relations.filter((x:any)=>(x.verdict==='SOSTENIDA'||(options.force&&x.originalCriticVerdict==='SOSTENIDA'))&&(!options.relationIds?.length||options.relationIds.includes(x.relationId)))){
    if(!options.force&&prior.some((x:any)=>x.relationId===r.relationId&&!['ERROR','SKIPPED'].includes(x.status)))continue;
    if(options.force&&r.originalCriticVerdict==='SOSTENIDA')r.verdict='SOSTENIDA';
    const p=r.evidence, baseline=(p?.overlap?.sampleKeys??[]).filter((v:any)=>v!=null).map(String).slice(0,thresholds.criticProbeLimit);
    const normalization:NormalizationMode=(r.normalization??cfg.normalizationContract?.defaultMode??'integer');
    if(!cfg.normalizationContract?.modes?.[normalization])throw new SafeError('NORMALIZATION_NOT_DECLARED_FOR_UNIVERSE');
    if(!baseline.length){log.push({relationId:r.relationId,status:'INSUFFICIENT',reason:'no_keys_for_bounded_counterprobe',counterprobes:[]});continue;}
    const sourceSpec=cfg.tables[r.from.table];
    if(!sourceSpec||!sourceSpec.columns.some((c:any)=>c.name===r.from.column))throw new SafeError('CRITIC_SOURCE_KEY_OUTSIDE_ALLOWLIST');
    const sourceFields=[...new Set([r.from.column,...(inventory.tables[r.from.table]?.labels??[])])];
    const sourceTable=sourceSpec.baseSql?sourceQuery(sourceSpec):`${identifier(r.from.db)}.${identifier(sourceSpec.physicalTable??r.from.table)}`;
    const newSql=`SELECT ${sourceFields.map(identifier).join(', ')} FROM ${sourceTable} WHERE (${identifier(r.from.column)} NOT IN (${quotedValues(baseline)}) OR ${identifier(r.from.column)} IS NULL) LIMIT ${thresholds.criticProbeLimit}`;
    let source:any=null,sourceError:any=null,fringe:string[]=[];
    try{source=await z.runSql(newSql,thresholds.criticProbeLimit);trace({role:'critic',action:'counterprobe',relationId:r.relationId,strategy:'unseen source keys and NULL edge',sql:newSql,requestId:source.requestId,result:{rows:source.rows.length,nullKeys:source.rows.filter((row:any[])=>row[sourceFields.indexOf(r.from.column)]==null).length}});fringe=[...new Set<string>(source.rows.map((row:any[])=>row[sourceFields.indexOf(r.from.column)]).filter((v:any)=>v!=null).map((v:any)=>String(v)))].slice(0,thresholds.criticProbeLimit);}
    catch(error){const requestId=lastRequestId(tracePath);sourceError=failure(error);trace({role:'critic',action:'counterprobe_error',relationId:r.relationId,strategy:'unseen source keys and NULL edge',sql:newSql,requestId,reason:sourceError});}
    const sampleSource=inventory.tables[r.from.table];
    const seedRawAll=fringe.length?fringe:sampleSource.sample.rows.map((row:any[])=>row[sampleSource.columns.indexOf(r.from.column)]).filter((v:any)=>v!=null).map(String);
    const seedRaw=seedRawAll.slice(0,r.normalization==='integer-pad10'?12:25);
    const seeds=[...new Set(seedRaw.map((v:string)=>key(v,normalization)).filter((v:any)=>v!==null))] as string[];
    const labels=inventory.tables[r.to.table]?.labels??[];
    const fields=[...new Set([r.to.column,...labels])];
    const targetSpec=cfg.tables[r.to.table],targetTable=targetSpec?.baseSql?sourceQuery(targetSpec):`${identifier(r.to.db)}.${identifier(targetSpec?.physicalTable??r.to.table)}`;
    if(!targetSpec||!targetSpec.columns.some((c:any)=>c.name===r.to.column))throw new SafeError('CRITIC_KEY_OUTSIDE_ALLOWLIST');
    const targetVals=[...seedRaw,...seeds,...(normalization==='integer-pad10'?seedRaw.filter((v:string)=>/^\d+$/.test(v)).map((v:string)=>v.padStart(10,'0')):[]),...(normalization==='integer'?seedRaw.filter((v:string)=>/^-?\d+$/.test(v)).map((v:string)=>v+'.0'):[])].filter((v:string,i:number,a:string[])=>a.indexOf(v)===i).slice(0,thresholds.criticProbeLimit);
    const sql=`SELECT ${fields.map(identifier).join(', ')} FROM ${targetTable} WHERE ${identifier(r.to.column)} IN (${quotedValues(targetVals)}) LIMIT ${thresholds.criticProbeLimit}`;
    let q:any;try{q=await z.runSql(sql,thresholds.criticProbeLimit);}catch(error){const requestId=lastRequestId(tracePath),result={relationId:r.relationId,status:'ERROR',reason:failure(error),counterprobes:[{strategy:fringe.length?'unseen source fringe → bounded target lookup':'CACHED baseline fallback → bounded target lookup',sql,requestId,sourceRequestId:source?.requestId??null,sourceError}]};log.push(result);r.critic={status:'ERROR',reason:result.reason,counterprobes:result.counterprobes};trace({role:'critic',action:'counterprobe_error',relationId:r.relationId,strategy:result.counterprobes[0].strategy,sql,requestId,reason:result.reason});writeJson(`evidence/critic-${id}-${r.relationId}.json`,{role:'critic',action:'counterprobe_error',...result});continue;}
    const idx=fields.indexOf(r.to.column), counts=new Map<string,number>();
    for(const row of q.rows){const k=key(row[idx],normalization);if(k!==null)counts.set(k,(counts.get(k)??0)+1);}
    const duplicates=[...counts].filter(([,n])=>n>1).map(([k,n])=>({key:k,rows:n}));
    const found=new Set(counts.keys()), matched=seeds.filter((s:string)=>{const k=key(s,normalization);return k!==null&&found.has(k);}).length;
    const matchedRows=q.rows.filter((row:any[])=>{const k=key(row[idx],normalization);return k!==null&&found.has(k);});
    let labelAgreement:any=undefined;
    if(labels.length){
      // This relation's stored source-side sample has bounded labels if present.
      const left=inventory.tables[r.from.table], leftLabels=left?.labels??[];
      if(leftLabels.length===labels.length){
        const leftMap=new Map<string,string[]>();
      const leftRows=fringe.length?source.rows:left.sample.rows,leftCols=fringe.length?sourceFields:left.columns;
        for(const row of leftRows){const k=key(row[leftCols.indexOf(r.from.column)],normalization);if(k!==null)leftMap.set(k,leftLabels.map((c:string)=>String(row[leftCols.indexOf(c)]??'').trim().toLowerCase()));}
        const pairs=matchedRows.map((row:any[])=>{const k=key(row[idx],normalization);if(k===null)return null;const a=leftMap.get(k);return a?{a,b:labels.map((c:string)=>String(row[fields.indexOf(c)]??'').trim().toLowerCase())}:null;}).filter(Boolean);
        if(pairs.length)labelAgreement={agree:pairs.filter((x:any)=>x.a.every((v:string,i:number)=>v===x.b[i])).length,compared:pairs.length,ratio:pairs.filter((x:any)=>x.a.every((v:string,i:number)=>v===x.b[i])).length/pairs.length};
      }
    }
    const requestId=q.requestId;
    const targetLimited=q.rows.length>=thresholds.criticProbeLimit;
    let sponsor:any=null;
    if(id==='U2'&&r.relationId==='company_sic_reference'&&sponsorAvailable){
      const vals=[...new Set(seedRaw)].slice(0,thresholds.criticProbeLimit);
      const sponsorSql=`SELECT sic_code, description FROM lightning.metastore.usl_demo.sic_edgar_usl.sic_code WHERE sic_code IN (${quotedValues(vals)}) LIMIT ${thresholds.criticProbeLimit}`;
      try{sponsor=await z.runSql(sponsorSql,thresholds.criticProbeLimit);trace({role:'critic',action:'sponsor_counterprobe',relationId:r.relationId,sql:sponsorSql,requestId:sponsor.requestId,result:{rows:sponsor.rows.length,distinctCodes:new Set(sponsor.rows.map((x:any[])=>String(x[0]))).size}});}
      catch(error){sponsor={status:'UNAVAILABLE',error:failure(error)};trace({role:'critic',action:'sponsor_counterprobe_error',relationId:r.relationId,reason:sponsor.error});}
    }
    if(sponsor?.rows){const sponsorKeys=new Set(sponsor.rows.map((x:any[])=>key(x[0],normalization)).filter((x:any)=>x!==null));const sponsorMatched=seeds.filter((s:string)=>{const k=key(s,normalization);return k!==null&&sponsorKeys.has(k);}).length;sponsor.metrics={matched:sponsorMatched,probed:seeds.length,ratio:seeds.length?sponsorMatched/seeds.length:null};}
    const judgement=judgeCounterprobe({duplicateKeys:duplicates,labelAgreement,overlap:seeds.length?matched/seeds.length:null,seedKeys:seeds.length,matchedKeys:matched,targetTruncated:targetLimited,sourceError,sponsor},thresholds);
    const reasons=judgement.reasons,finalStatus=judgement.status,insufficient=finalStatus==='INSUFFICIENT';
    const strategy=fringe.length?'unseen source fringe → bounded target lookup':'CACHED baseline fallback → bounded target lookup';
    const counter:Counterprobe={relationId:r.relationId,strategy,sql,requestId,utc:q.utc,rows:q.rows.slice(0,3),metrics:{sourceRequestId:source?.requestId??null,sourceRows:source?.rows.length??0,sourceSampleLimitReached:Boolean(source&&source.rows.length>=thresholds.criticProbeLimit),sourceNullRate:source?.rows.length?source.rows.filter((row:any[])=>row[sourceFields.indexOf(r.from.column)]==null).length/source.rows.length:null,sourceError,seedKeys:seeds.length,matchedKeys:matched,overlap:seeds.length?matched/seeds.length:null,returnedRows:q.rows.length,distinctReturnedKeys:counts.size,duplicateKeys:duplicates,labelAgreement,sponsor:sponsor?{status:sponsor.status??'PASS',requestId:sponsor.requestId??null,rows:sponsor.rows?.length??0,error:sponsor.error??null,metrics:sponsor.metrics??null}:null},status:finalStatus};
    log.push({relationId:r.relationId,status:counter.status,reason:counter.status==='DEGRADED'?reasons.join('; ')||'critic thresholds failed':sourceError?'source counterprobe failed; bounded target fallback ran; result remains insufficient':insufficient?'bounded response did not cover every sampled key':'counterprobe thresholds retained',counterprobes:[counter]});
    if(counter.status==='DEGRADED'){
      r.originalCriticVerdict='SOSTENIDA';r.verdict='INDETERMINADA';r.rule='critic_downgrade';r.critic={status:'DEGRADED',reason:reasons.join('; '),counterprobes:[counter]};
      trace({role:'critic',action:'downgrade',relationId:r.relationId,from:'SOSTENIDA',to:'INDETERMINADA',reason:reasons.join('; '),requestId});
    } else r.critic={status:counter.status,reason:counter.status==='INSUFFICIENT'?'insufficient counterprobe evidence':'thresholds retained',counterprobes:[counter]};
    writeJson(`evidence/critic-${id}-${r.relationId}.json`,{role:'critic',action:'counterprobe',...counter});
    trace({role:'critic',action:'counterprobe',relationId:r.relationId,strategy:counter.strategy,sql,requestId,result:{rows:q.rows.length,metrics:counter.metrics},status:counter.status});
  }
  relations.critic={runId,utc:new Date().toISOString(),confirmed:log.filter(x=>x.status==='CONFIRMED').length,degraded:log.filter(x=>x.status==='DEGRADED').length,insufficient:log.filter(x=>x.status==='INSUFFICIENT').length,errors:log.filter(x=>x.status==='ERROR').length,skipped:log.filter(x=>x.status==='SKIPPED').length,results:log};
  writeRelations(relations,id);
  for(const x of log.filter(x=>x.status==='DEGRADED'))writeJson(`evidence/critic-downgrade-${id}-${x.relationId}.json`,{role:'critic',action:'downgrade',from:'SOSTENIDA',to:'INDETERMINADA',reason:x.reason,utc:new Date().toISOString()});
  const lines=['# Crítica adversarial '+id,'',`Confirmadas: ${relations.critic.confirmed}; degradadas: ${relations.critic.degraded}; insuficientes: ${relations.critic.insufficient}; errores: ${relations.critic.errors}; omitidas: ${relations.critic.skipped}.`,'','Las métricas describen respuestas limitadas a 50 filas; no establecen cobertura ni unicidad global.'];
  for(const x of log)lines.push('',`## ${x.relationId}: ${x.status}`,'',x.reason,...(x.counterprobes??[]).map((c:any)=>`- ${c.strategy}; ${c.metrics?.matchedKeys??'—'}/${c.metrics?.seedKeys??'—'} claves en respuesta; duplicados observados: ${c.metrics?.duplicateKeys?.length??0}; requestId ${c.requestId??'no disponible'}.`));
  writeJson(`out/${id}/critic.json`,relations.critic);fs.writeFileSync(path.join(ROOT,`out/${id}/critic.md`),lines.join('\n')+'\n');
  const events=fs.readFileSync(tracePath,'utf8').slice(traceOffset).split(/\r?\n/).filter(Boolean).map((line:string)=>JSON.parse(line));
  fs.mkdirSync(path.join(ROOT,'evidence','runs',runId),{recursive:true});fs.writeFileSync(path.join(ROOT,'evidence','runs',runId,'trace.jsonl'),events.map((e:any)=>JSON.stringify(e)).join('\n')+'\n');
  writeJson(`evidence/runs/${runId}/critic.json`,{runId,universe:id,...relations.critic});
  return relations.critic;
  }catch(error){writeJson(`evidence/runs/${runId}/critic-error.json`,{runId,universe:id,error:failure(error),utc:new Date().toISOString()});throw error;}
  finally{setTraceRun();}
}
