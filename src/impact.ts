import fs from 'node:fs';
import path from 'node:path';
import { normalizeKey, type NormalizationMode } from './universe.ts';
import { ROOT, readJson, writeJson } from './runtime.ts';

export type Impact = {
  relationId:string; sample:number; misattributed:number|null; unmatched:number;
  lostMatches:number; examples:{key:string;wrong:string|null;right:string|null}[];
  sentence:string; status:string; unit:string; cacheLabel:string; sourceUtc:string[];
  requestIds:string[]; sqlCalls:0; generations:0; method:string;
};
const endpoint=(e:any)=>[e.db,e.table,e.column].join('.');
const literal=(v:unknown)=>v==null?null:String(v);
const label=(row:any[])=>row.slice(1).map(v=>String(v??'').trim()).join(' / ');
const sameEndpoints=(a:any,b:any)=>endpoint(a.from)===endpoint(b.from)&&endpoint(a.to)===endpoint(b.to);
export function computeImpacts(relations:any[],inventory:any):Impact[] {
  const impacts:Impact[]=[];
  for(const relation of relations){
    const normalized=relations.find(r=>r!==relation&&sameEndpoints(r,relation)&&r.verdict==='SOSTENIDA'&&r.normalization&&r.normalization!=='text');
    const formatTrap=relation.verdict==='INDETERMINADA'&&relation.normalization==='text'&&normalized;
    if(relation.verdict!=='ENGAÑOSA'&&!formatTrap)continue;
    const queries=relation.evidence.queries??[],left=queries[0]?.rows.slice(0,20)??[];
    const target=(formatTrap?normalized.evidence.queries[1]?.rows:queries[1]?.rows)?.slice(0,20)??[];
    const refs=[...queries,...(formatTrap?normalized.evidence.queries:[])];
    const dates=[...new Set<string>(refs.map(q=>q.utc).filter(Boolean))];
    const result:Impact={relationId:relation.relationId,sample:left.length,misattributed:0,unmatched:0,lostMatches:0,examples:[],sentence:'',status:'MEASURED',
      unit:formatTrap?'source records with a lost company-key link':'sampled catalog records, not trips or population-wide errors',
      cacheLabel:'CACHED '+(relation.evidence.utc??dates[0]??'unknown'),sourceUtc:dates,requestIds:[...new Set<string>(refs.map(q=>q.requestId).filter(Boolean))],sqlCalls:0,generations:0,method:'client-side literal equality over previously obtained samples; at most 20 records per side'};
    if(!left.length||!queries[0]||(!formatTrap&&(!inventory.tables[relation.from.table]?.labels?.length||!inventory.tables[relation.to.table]?.labels?.length))){
      result.status='INSUFFICIENT_EVIDENCE';result.misattributed=null;result.sentence='Impacto no cuantificable: faltan filas o etiquetas comparables; no se supone daño cero.';impacts.push(result);continue;
    }
    for(const row of left){
      const key=literal(row[0]);if(key===null){result.unmatched++;continue;}
      const wrong=target.filter((r:any[])=>literal(r[0])===key);
      if(!wrong.length)result.unmatched++;
      if(formatTrap){
        const mode=(normalized.normalization??'integer-pad10') as NormalizationMode;
        const right=target.filter((r:any[])=>normalizeKey(r[0],mode)===normalizeKey(row[0],mode));
        if(!wrong.length&&right.length){result.lostMatches++;result.examples.push({key,wrong:null,right:literal(right[0][0])});}
      }else{
        // Count affected source records once, even if the join multiplies rows.
        const incorrect=wrong.find((r:any[])=>label(r).toLowerCase()!==label(row).toLowerCase());
        if(incorrect){result.misattributed!++;result.examples.push({key,wrong:label(incorrect),right:label(row)});}
      }
    }
    result.examples=result.examples.slice(0,3);
    const a=endpoint(relation.from),b=endpoint(relation.to);
    result.sentence=formatTrap?
      `Si unes ${a} con ${b} por igualdad textual, ${result.lostMatches} de ${result.sample} registros de la muestra quedan sin vínculo recuperable con la normalización ya verificada; ${result.misattributed} se atribuyen a otra empresa.`:
      `Si unes ${a} con ${b} por ID literal, ${result.misattributed} de ${result.sample} registros de esta muestra reciben etiquetas de ${relation.to.table} en vez de las de ${relation.from.table}, usada como referencia de este contrafactual. No es un conteo de viajes ni una estimación económica.`;
    impacts.push(result);
  }
  return impacts;
}
export function impactMarkdown(impacts:Impact[],labelText:string){
  return ['## El coste del error — P1','',labelText,'','Unión en cliente de muestras guardadas, máximo 20 registros por lado. Cero consultas nuevas; no se extrapola a la población.','',...impacts.flatMap(i=>[
    `### ${i.relationId}`,'',i.sentence,'',`${i.cacheLabel}. requestIds: ${i.requestIds.join(', ')}.`,
    ...i.examples.map(x=>`- Clave ${x.key}: wrong=${x.wrong??'sin vínculo'}; right=${x.right??'sin referencia'}.`),''])].join('\n');
}
export function persistImpacts(id:string,inventory?:any,relations?:any,options?:{sample:boolean;sourceUtc:string}){
  const inv=inventory??readJson(`out/${id}/discovery.json`),rels=relations??readJson(`out/${id}/relaciones.json`);
  const impacts=computeImpacts(rels.relations,inv),sourceUtc=options?.sourceUtc??rels.utc;
  const cacheLabel=options?.sample&&rels.syntheticFixture?'SYNTHETIC FIXTURE':'CACHED '+sourceUtc;
  const output={generatedUtc:new Date().toISOString(),universe:id,cacheLabel,live:false,sqlCalls:0,generations:0,impacts};
  const dir=`out/${id}${options?.sample?'/sample':''}`;
  writeJson(dir+'/impact.json',output);
  const block='<!-- CONCORDIA_IMPACT -->\n'+impactMarkdown(impacts,output.cacheLabel)+'\n<!-- /CONCORDIA_IMPACT -->';
  const file=path.join(ROOT,dir,'relaciones.md');
  const previous=fs.existsSync(file)?fs.readFileSync(file,'utf8'):`# Relaciones ${id}\n\n${output.cacheLabel}\n`;
  fs.writeFileSync(file,previous.includes('<!-- CONCORDIA_IMPACT -->')?previous.replace(/<!-- CONCORDIA_IMPACT -->[\s\S]*?<!-- \/CONCORDIA_IMPACT -->/,block):previous.trimEnd()+'\n\n'+block+'\n');
  return output;
}
