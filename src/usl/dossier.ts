import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readJson, writeJson, SafeError } from '../runtime.ts';
import { computeImpacts, impactMarkdown, persistImpacts } from '../impact.ts';

export type RelationContract={relationId:string;from:any;to:any;normalization:string;verdict:string;reason:string;evidenceId:string;confidence:number|null;evidence:any;costExcluded:boolean;uslColumn?:string;operation?:string;impact?:any;reviewStatus?:string;critic?:any;eligibleForNewUsl:boolean};
const endpoints=(r:any)=>JSON.stringify([r.from.db,r.from.table,r.from.column,r.to.db,r.to.table,r.to.column]);
export function evidenceConfidence(r:any,cfg:any){
  if(r.evidence?.kind==='schema-correspondence')return null;
  // Zero means no current support for publishing this FK, not certainty about
  // an alternative identity. Preserve the old score in baseline evidence.
  if(r.critic?.status==='DEGRADED')return 0;
  const p=r.evidence,counter=r.critic?.counterprobes?.find((c:any)=>typeof c.metrics?.overlap==='number');
  const ratio=counter?.metrics.overlap??p?.overlap?.ratio;
  return typeof ratio==='number'?Math.min(1,Math.max(0,cfg.relationBase+cfg.relationOverlapWeight*ratio+cfg.compatibleTypeWeight*Number(p.typeCompat?.castable===true))):null;
}
export function relationContract(r:any,cfg:any,excluded:string[]):RelationContract{
  const p=r.evidence??{},critic=r.critic,counters=critic?.counterprobes??[];
  const requestIds=[...new Set<string>([...(p.queries??[]).map((q:any)=>q.requestId),...counters.flatMap((c:any)=>[c.metrics?.sourceRequestId,c.sourceRequestId,c.requestId])].filter(Boolean))];
  const counter=counters.findLast((c:any)=>c.requestId),utc=counter?.utc??p.utc;
  return {relationId:r.relationId,from:r.from,to:r.to,normalization:r.normalization??p.typeCompat?.normalization??'unspecified',verdict:r.verdict,
    reason:critic?.status==='DEGRADED'?'critic_downgrade: '+critic.reason:r.rule??r.explanation,evidenceId:counter?.requestId?`${r.relationId}:critic:${counter.requestId}`:r.evidenceId??r.relationId,
    confidence:evidenceConfidence(r,cfg),costExcluded:excluded.includes(r.from.table)||excluded.includes(r.to.table),
    critic,eligibleForNewUsl:r.verdict==='SOSTENIDA',
    evidence:{utc,baselineUtc:p.utc,requestIds,sourceUtc:[...(p.queries??[]).map((q:any)=>q.utc),...counters.map((c:any)=>c.utc)].filter(Boolean),
      overlap:p.overlap,multiplicity:p.multiplicity??null,labelAgreement:p.labelAgreement??null,typeCompat:p.typeCompat,alerts:p.alerts??[],critic,cacheLabel:'CACHED '+utc}};
}
export function pendingRequirements(r:any,thresholds:any){
  if(r.kind==='schema-correspondence')return ['Concepto de columna inequívoco y evidencia de tipo suficiente; no establece una FK ni identidad empresarial.'];
  const p=r.evidence??{},needs:string[]=[];
  if(r.critic?.status==='DEGRADED')needs.push(`Resolver la contraprueba del crítico (${r.critic.reason}); FK excluida de modelos nuevos y en revisión en el USL existente.`);
  if(p.multiplicity?.to?.duplicateKeys?.length)needs.push('Resolver las claves duplicadas observadas en el lado referenciado; la respuesta acotada no demuestra unicidad global.');
  if(p.multiplicity?.manyToManyKeys?.length)needs.push(`Revisar la multiplicidad many-to-many observada (${p.multiplicity.sharedRowPairs} pares en las respuestas acotadas); no publicar como FK simple.`);
  if(p.status!=='PASS')needs.push('Resolver el fallo de sonda; sin reintento automático.');
  if(p.alerts?.length)needs.push('Revisar las alertas de calidad de la muestra antes de aceptar la relación.');
  const minimum=p.relation?.minDistinctKeys??thresholds.minDistinctKeys;
  if((p.overlap?.probed??0)<minimum)needs.push(`Observar al menos ${minimum} claves distintas no nulas, o justificar un contrato específico de fuente.`);
  if(p.overlap?.ratio==null||p.overlap.ratio<thresholds.sustainedOverlap)needs.push(`Demostrar solapamiento de muestra >=${thresholds.sustainedOverlap}; una normalización requiere su propia evidencia.`);
  if(!p.typeCompat?.castable)needs.push('Confirmar tipos compatibles o una normalización explícita sin pérdida.');
  return needs.length?needs:['Revisión de la evidencia y del contrato semántico; no fabricar una FK.'];
}
export function buildDossier(id:string,inventory:any,relations:any,model:any,cfg:any,thresholds:any,excluded:string[],comment:any){
  const rows=relations.relations,impacts=computeImpacts(rows,inventory),contracts=rows.map((r:any)=>relationContract(r,cfg,excluded));
  const foreignKeys:RelationContract[]=(model?.mappings??[]).map((m:any)=>{
    const r=contracts.find((r:RelationContract)=>r.relationId===m.relationId);
    if(!r)throw new SafeError('USL_FK_WITHOUT_RELATION_EVIDENCE');
    if(r.verdict!=='SOSTENIDA'&&r.critic?.status!=='DEGRADED')throw new SafeError('USL_FK_NO_LONGER_SUPPORTED_REQUIRES_REVIEW');
    return {...r,uslColumn:m.uslColumn,reviewStatus:r.verdict==='SOSTENIDA'?'confirmed':'en revisión'};
  });
  const forbidden:RelationContract[]=contracts.filter((c:RelationContract)=>c.verdict==='ENGAÑOSA').map((c:RelationContract)=>({...c,operation:'literal-key-join',impact:impacts.find(i=>i.relationId===c.relationId)}));
  for(const c of contracts.filter((c:RelationContract)=>c.critic?.status==='DEGRADED'))forbidden.push({...c,operation:'excluded-pending-critic-review'});
  for(const r of rows.filter((r:any)=>r.verdict==='INDETERMINADA'&&r.normalization==='text')){
    const corrected=rows.find((s:any)=>s.verdict==='SOSTENIDA'&&s.normalization&&s.normalization!=='text'&&endpoints(s)===endpoints(r));
    if(corrected)forbidden.push({...contracts.find((c:RelationContract)=>c.relationId===r.relationId)!,reason:'unsafe_literal_equality_format_mismatch; normalized edge remains independently allowed',operation:'literal-equality-only',impact:impacts.find(i=>i.relationId===r.relationId)});
  }
  const pending=rows.filter((r:any)=>r.verdict==='INDETERMINADA').map((r:any)=>({...contracts.find((c:RelationContract)=>c.relationId===r.relationId),missing:pendingRequirements(r,thresholds)}));
  const sourceUtc=relations.critic?.utc??relations.utc,cacheLabel=relations.syntheticFixture?'SYNTHETIC FIXTURE':'CACHED '+sourceUtc;
  const header=['# Dossier USL '+id,'',cacheLabel,'',`Modelo: ${model?.fullModel??'no desplegado (correspondencias de esquema no son FKs)'}. Generado desde evidencia guardada, sin SQL ni LLM.`,
    'Confianza = .50 + .25*overlap + .10*tipos compatibles (config/reconcile.json); si el crítico degrada, soporte actual de la FK = 0. Score de evidencia, no probabilidad calibrada ni garantía global. Cada contraprueba y la sonda inicial conservan su fecha propia. La normalización procede del contrato del universo y la arista; no se canonizan claves a ciegas. Etiquetas ausentes significan evidencia semántica ausente, nunca 100 % de acuerdo. Los duplicados se describen sobre filas observadas; ausencia de duplicados no prueba unicidad global.','',
    'La reconciliación conserva alternativas con regla, source, versión, fecha de observación y requestIds; la evidencia reinyectada recupera contexto sin sumar un voto nuevo. Umbrales de resolución: ganador ≥0,70 y margen ≥0,20.','',
    '## FKs del USL','',`FKs declaradas: ${foreignKeys.length}. La presencia en el modelo no prueba una lectura exitosa ni integridad global.`,''];
  for(const fk of foreignKeys)header.push(`### ${fk.from.table}.${fk.uslColumn} → ${fk.to.table}.${fk.to.column}`,'',
    `Origen físico: ${fk.from.db}.${fk.from.table}.${fk.from.column}. Veredicto: ${fk.verdict}. Estado: ${fk.reviewStatus}. Confianza: ${fk.confidence??'no calculable'}. Normalización declarada: ${fk.normalization}.`,
    `evidenceId: ${fk.evidenceId}; fecha: ${fk.evidence.utc}; requestIds: ${fk.evidence.requestIds.join(', ')}.`,
    `Multiplicidad observada en respuestas acotadas (no unicidad global): ${JSON.stringify(fk.evidence.multiplicity)}.`,
    `Estado de coste: ${fk.costExcluded?'exclusión histórica D2/D3; lectura del USL hvv no confirmada entonces. Jonás revocó la exclusión de consultas útiles en D4a; la crítica indica qué se ejecutó ahora':'sin exclusión de coste histórica'}.`,
    `Elegible para un USL nuevo: ${fk.eligibleForNewUsl?'sí, según el veredicto acotado':'no; el modelo desplegado se conserva sin modificar'}.`,
    '', '```json',JSON.stringify({baselineUtc:fk.evidence.baselineUtc,overlap:fk.evidence.overlap,multiplicity:fk.evidence.multiplicity,labelAgreement:fk.evidence.labelAgreement,typeCompat:fk.evidence.typeCompat,critic:fk.critic},null,2),'```','');
  header.push('## Rechazadas (Negative USL)','',`Relaciones excluidas o prohibidas: ${forbidden.length}. excluded-pending-critic-review es una exclusión provisional, no una identidad alternativa ni un veredicto ENGAÑOSA. La prohibición de igualdad literal no prohíbe una arista normalizada con su propia evidencia.`,'');
  for(const n of forbidden)header.push(`### ${n.relationId}`,'',`${n.from.table}.${n.from.column} → ${n.to.table}.${n.to.column}; ${n.verdict}; ${n.reason}.`,
    `Operación prohibida: ${n.operation}. evidenceId: ${n.evidenceId}; requestIds: ${n.evidence.requestIds.join(', ')}.`,
    '',n.impact?.sentence??'Impacto no cuantificable con la evidencia disponible.',...(n.impact?.examples??[]).map((x:any)=>`- Clave ${x.key}: wrong=${x.wrong??'sin vínculo'}; right=${x.right??'sin referencia'}.`),'');
  header.push('## Pendientes','');
  for(const p of pending)header.push(`- ${p.relationId}: ${p.missing.join(' ')} Fecha ${p.evidence.utc}; requestIds ${p.evidence.requestIds.join(', ')}.`);
  if(!pending.length)header.push('Ninguna relación INDETERMINADA en esta evidencia.');
  header.push('','## Excluidas por coste','',...(excluded.length?excluded.map(t=>`- ${t}: exclusión histórica D2/D3, no una restricción vigente. Se conserva la distinción entre lectura del USL y contrasondas D4a sobre fuentes físicas; las llamadas nuevas figuran con su requestId en Crítica.`):['Ninguna exclusión de coste histórica en este universo.']),
    '','## Comentarios embebidos','',comment?`Prueba única U1: ${comment.status}; ${comment.compileStatements} sentencia COMPILE sin DEPLOY. ${comment.error?.detail??'Resultado en evidence/comment-probe-04b.json'}. No se reemplaza un USL existente. Los comentarios de cada FK quedan en este dossier si COMMENT no se admite en la forma probada.`:'COMMENT pendiente de prueba única autorizada. No se infiere soporte.',
    '',impactMarkdown(impacts,cacheLabel));
  return {cacheLabel,universe:id,sourceUtc,foreignKeys,forbidden,pending,excludedByCost:excluded,comments:comment?{status:comment.status,evidence:'evidence/comment-probe-04b.json'}:null,markdown:header.join('\n')+'\n'};
}
export function uslDossier(id:string,options?:{snapshot:any;sample:boolean}){
  const inventory=options?.snapshot.artifacts.discovery??readJson(`out/${id}/discovery.json`),relations=options?.snapshot.artifacts.relaciones??readJson(`out/${id}/relaciones.json`);
  const publicFixture=options?.sample===true&&options.snapshot.publicFixture===true;
  const completeFile=`out/${id}/usl-complete.json`,demoFile=`out/${id}/usl-demo.json`;
  const model=publicFixture||id==='U3'?null:fs.existsSync(path.join(ROOT,completeFile))?readJson(completeFile):fs.existsSync(path.join(ROOT,demoFile))?readJson<any>(demoFile).modelDetails??null:null;
  const commentFile='evidence/comment-probe-04b.json',comment=!publicFixture&&fs.existsSync(path.join(ROOT,commentFile))?readJson(commentFile):null;
  const dossier=buildDossier(id,inventory,relations,model,readJson('config/reconcile.json'),readJson('config/thresholds.json'),readJson('config/cost-exclusions.json')[id]??[],comment);
  const sample=options?.sample??false,dir=`out/${id}${sample?'/sample':''}`;
  persistImpacts(id,inventory,relations,{sample,sourceUtc:relations.utc});
  writeJson(dir+'/negative_usl.json',{universe:id,cacheLabel:dossier.cacheLabel,sqlCalls:0,generations:0,relations:dossier.forbidden});
  writeJson(dir+'/usl-dossier.json',{...dossier,markdown:undefined});
  const destination=sample?`${dir}/USL_${id}.md`:`docs/USL_${id}.md`;
  fs.mkdirSync(path.dirname(path.join(ROOT,destination)),{recursive:true});fs.writeFileSync(path.join(ROOT,destination),dossier.markdown);
  return dossier;
}
