import fs from 'node:fs';
import path from 'node:path';
import { ROOT, sanitize } from '../runtime.ts';
import { computeImpacts } from '../impact.ts';
import { assessConsumerInputVersions, consumerFreshnessSnapshot, type ConsumerFreshnessSnapshot } from '../reconcile/consumer-freshness.ts';
export const escapeHtml=(v:unknown)=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
// Oculta rutas locales en todas sus formas (C:\x, C:/x, C:\\x escapada en JSON, file:///C:/x, %5C/%3A codificadas, UNC, /c/x de git-bash, /home|Users|... ) y deja intactas las URLs http(s).
const PATH_TAIL = '[^\\s"\'<>|,;)&]*';
const SCRUB_RULES: [RegExp, string][] = [
  [new RegExp(`file:(?:/|%2F){2,}${PATH_TAIL}`, 'gi'), '[ruta local]'],
  [new RegExp(`(?<![A-Za-z0-9/])[A-Za-z](?::|%3A)(?:[\\\\/]|%5C|%2F)+${PATH_TAIL}`, 'gi'), '[ruta local]'],
  [new RegExp(`(^|[^\\w\\\\])(?:\\\\|%5C){2,}[\\w.$-]{2,}(?:[\\\\/]|%5C)${PATH_TAIL}`, 'gi'), '$1[ruta local]'],
  [new RegExp(`(^|[\\s"'(;=>])/(?:[A-Za-z]|home|Users|root|mnt|tmp|var|opt)/${PATH_TAIL}`, 'g'), '$1[ruta local]'],
];
export const scrub = (text: string): string => SCRUB_RULES.reduce((t, [re, to]) => t.replace(re, to), sanitize(text));
const pre=(v:unknown)=>'<pre>'+escapeHtml(typeof v==='string'?v:JSON.stringify(v,null,2))+'</pre>';
const section=(name:string,body:string)=>'<section><h2>'+escapeHtml(name)+'</h2>'+body+'</section>';
/** La etiqueta de modo nace de run.executionMode y run.dataOrigin; si no se conocen, UNKNOWN, nunca LIVE por defecto. */
export function modeLabel(run:any){
  const mode=['LIVE','LOCAL','REPLAY'].includes(run?.executionMode)?run.executionMode:'UNKNOWN',origin=['SYNTHETIC','PUBLIC','USER','UNKNOWN'].includes(run?.dataOrigin)?run.dataOrigin:typeof run?.dataOrigin?.label==='string'&&run.dataOrigin.label?run.dataOrigin.label:'UNKNOWN';
  return mode==='LIVE'?`LIVE ${run.utc}; origen de datos: ${origin}; cada evidencia conserva su fecha propia`:`${mode} (modo de ejecucion ${mode==='UNKNOWN'?'no registrado en el run':'registrado'}); origen de datos: ${origin}; cada evidencia conserva su fecha propia`;
}
export function reportHtml(id:string,run:any,bundle:any) {
  const e=escapeHtml,relations=bundle.artifacts.relaciones.relations;
  const impacts=computeImpacts(relations,bundle.artifacts.discovery??{tables:{}}),dossier=bundle.artifacts.dossier;
  const impactBody=impacts.length?impacts.map(i=>'<article class="impact"><h3>'+e(i.relationId)+'</h3><p><strong>'+e(i.sentence)+'</strong></p><p>'+e(i.cacheLabel)+' · Muestra '+e(i.sample)+'; atribución errónea '+e(i.misattributed??'no cuantificable')+'; vínculos perdidos '+e(i.lostMatches)+'.</p><details><summary>Ejemplos y procedencia</summary>'+pre({method:i.method,unit:i.unit,examples:i.examples,requestIds:i.requestIds,sourceUtc:i.sourceUtc})+'</details></article>').join(''):'<p>No hay relaciones engañosas o trampas de formato cuantificables en esta evidencia.</p>';
  const fichas=bundle.artifacts.fichas??{};
  const savedFichas=fichas.freshness as ConsumerFreshnessSnapshot|undefined,savedDossier=dossier?.freshness as ConsumerFreshnessSnapshot|undefined;
  const savedDependencies=[...(savedFichas?.dependencies??[]),...(savedDossier?.dependencies??[])],savedSnapshot:ConsumerFreshnessSnapshot|undefined=(savedFichas??savedDossier)?{schemaVersion:1,universeId:id,state:'UNKNOWN',dependencies:[...new Map(savedDependencies.map(item=>[item.relationId,item])).values()]}:undefined;
  const relationIds=[...new Set([...relations.map((relation:any)=>relation.relationId),...savedDependencies.map(item=>item.relationId)])];
  const currentFreshness=assessConsumerInputVersions(consumerFreshnessSnapshot(id,relationIds,savedSnapshot),relations.map((r:any)=>({relationId:r.relationId,verdict:r.verdict,contractVersion:r.contractVersion??r.contract?.contractVersion,decisionRef:r.decisionRef??r.decision?.decisionId,policyVersion:r.policyVersion??r.decision?.policyVersion,evidenceRefs:r.evidenceRefs??r.decision?.evidenceBundleRefs})));
  const currentByRelation=new Map(currentFreshness.dependencies.map(item=>[item.relationId,item]));
  const provenance=run.sampleMode?(run.cacheLabel??`CACHED ${bundle.sourceUtc}`):run.mode==='warm'?`CACHED ${bundle.sourceUtc}; disponibilidad Zetaris comprobada en vivo`:modeLabel(run);
  const table='<table><thead><tr><th>Relación</th><th>Veredicto</th><th>Evidencia</th></tr></thead><tbody>'+relations.map((r:any)=>{
    const evidence=r.evidence??{};
    const dependencyState=currentByRelation.get(r.relationId)?.state??'UNKNOWN';
    const current=r.critic?.status==='DEGRADED'?'<p><strong>Veredicto actual: INDETERMINADA por crítico ('+e(r.critic.reason)+').</strong> La explicación siguiente corresponde a la sonda base CACHED '+e(evidence.utc)+' y se conserva como historial, no como justificación del estado actual.</p>':'';
    return '<tr><td>'+e(r.relationId)+'</td><td class="'+e(dependencyState==='CURRENT'?r.verdict:'INDETERMINADA')+'">'+e(dependencyState==='CURRENT'?r.verdict:'HISTORICAL '+r.verdict+' ('+dependencyState+')')+'</td><td><details><summary>SQL, muestras, explicación</summary>'+current+pre(r.explanation)+pre({sourceUtc:evidence.utc,cacheLabel:evidence.cacheLabel,overlap:evidence.overlap,typeCompat:evidence.typeCompat,labelAgreement:evidence.labelAgreement,alerts:evidence.alerts})+(evidence.queries??[]).map((q:any)=>pre({utc:q.utc,sql:q.sql,requestId:q.requestId,rows:q.rows.slice(0,3)})).join('')+(r.llmExplanation?'<p>Redacción histórica reutilizada; recibo '+e(r.llmReceipt?.receiptId)+'</p>'+pre(r.llmExplanation):'')+'</details></td></tr>';
  }).join('')+'</tbody></table>';
  const displayedDossier=dossier?{...dossier,foreignKeys:(dossier.foreignKeys??[]).map((fk:any)=>{const state=currentByRelation.get(fk.relationId)?.state??'UNKNOWN';return state==='CURRENT'?{...fk,freshnessState:state}:{...fk,freshnessState:state,eligibleForNewUsl:false,freshnessReason:`dependency_${state.toLowerCase()}`};}),freshness:currentFreshness}:null;
  const dossierBody=displayedDossier?pre({sourceUtc:displayedDossier.sourceUtc,foreignKeys:displayedDossier.foreignKeys,negativeUSL:displayedDossier.forbidden,pending:displayedDossier.pending,excludedByCost:displayedDossier.excludedByCost,comments:displayedDossier.comments,freshness:displayedDossier.freshness}):'Dossier disponible mediante npm run usl-dossier.';
  const freshnessBody=pre({current:currentFreshness,saved:{fichas:savedFichas??null,dossier:savedDossier??null}});
  const critic= bundle.artifacts.relaciones.critic;
  const criticBody=critic?`<p>Confirmadas: ${e(critic.confirmed)}; degradadas: ${e(critic.degraded)}; insuficientes: ${e(critic.insufficient)}; omitidas: ${e(critic.skipped)}. Hasta 50 filas por consulta; sin afirmaciones de cobertura global.</p>`+(critic.results??[]).map((r:any)=>'<article><h3>'+e(r.relationId)+' · '+e(r.status)+'</h3><p>'+e(r.reason)+'</p>'+(r.counterprobes??[]).map((c:any)=>'<details><summary>'+e(c.strategy)+' · '+e(c.metrics?.matchedKeys??'—')+'/'+e(c.metrics?.seedKeys??'—')+' claves · '+e(c.metrics?.duplicateKeys?.length??0)+' duplicados · '+e(c.requestId)+'</summary><pre>'+e(c.sql)+'</pre>'+pre(c.metrics)+'</details>').join('')+'</article>').join(''):'<p>Crítica no disponible para esta evidencia.</p>';
  const receiptRows=(bundle.receipts??[]).map((r:any)=>'<tr><td>CACHED '+e(r.utc)+'</td><td>'+e(r.receiptId)+'</td><td>'+e(r.status??'historical')+'</td><td>'+e(r.provider)+' / '+e(r.model)+'</td><td>'+e(r.totalTokens)+'</td><td>'+e(r.predicted)+' → '+e(r.winner)+'; '+e(r.routingReason)+'</td></tr>').join('');
  const receiptsBody=bundle.publicFixture?'<p>La fixture sintética no contiene recibos.</p>':((bundle.receipts??[]).length?`<p>Se listan ${e((bundle.receipts??[]).length)} recibos históricos (estados originales: ${e([...new Set((bundle.receipts??[]).map((r:any)=>r.status??'historical'))].join(', '))}). Su presencia no significa aprobación ni una llamada nueva de esta corrida; el estado corresponde al intento original.</p>`:'<p>Este bundle no trae recibos.</p>');
  return '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Concordia '+e(id)+'</title><style>body{font:18px/1.5 system-ui,sans-serif;max-width:1250px;margin:32px auto;padding:0 20px;background:#f5f7fa;color:#182638}h1{font-size:40px}h2{font-size:27px}section{background:white;padding:24px;margin:20px 0;border:1px solid #d0d8e0;border-radius:10px}table{border-collapse:collapse;width:100%;font-size:16px}td,th{padding:12px;border-bottom:1px solid #d0d8e0;text-align:left;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.5 monospace;background:#f0f3f7;padding:16px}summary{cursor:pointer;font-weight:600}.SOSTENIDA{color:#17623a}.ENGAÑOSA{color:#a92728}.INDETERMINADA{color:#765000}.banner{background:#182638;color:white;padding:18px;border-radius:8px;position:sticky;top:0}small{color:#52667c}.impact{background:#fff3df;border-left:6px solid #ad5200;padding:18px;margin:16px 0}.impact strong{font-size:21px}</style><h1>Concordia · '+e(id)+'</h1><div class="banner">'+e(provenance)+'</div>'+(run.mode==='warm'?'<p>Corrida warm: reutiliza decisiones de una corrida previa (ver Resumen).</p>':'')+'<p>Los veredictos usan evidencia acotada; no prueban identidad, unicidad ni integridad global.</p>'+
    section('Resumen',pre({status:run.status,mode:run.mode,verdicts:run.verdicts,conflicts:run.conflicts,probes:run.sondas,generations:run.generations,effectiveModels:run.models,durationMs:run.durationMs,nightshift:run.nightshift,coldWarm:run.coldWarm,eval:bundle.artifacts.eval}))+
    section('El coste del error · P1',impactBody)+section('Relaciones',table)+section('Crítica',criticBody)+section('USL que se explica · P2 y Negative USL','<details><summary>FKs aceptadas, relaciones prohibidas y pendientes</summary>'+dossierBody+'</details>')+section('Estado de frescura y dependencias',freshnessBody)+section('Fichas y conflictos',(fichas.fichas??[]).map((f:any)=>'<details><summary>'+e(f.entityType)+' '+e(f.entityKey)+'</summary>'+pre(f)+'</details>').join('')||'<p>No hay identidades entre fuentes verificadas; no se fusionan empresas por nombre.</p>')+
    section('Ledger H-MEM','<details><summary>'+e(bundle.ledger?.length??0)+' entradas; procedencia y decisiones</summary>'+pre(bundle.ledger)+'</details>')+
    section(bundle.publicFixture?'Recibos':'Recibos históricos (CACHED con fecha, no generaciones de esta corrida)',receiptsBody+'<table><tr><th>Fecha origen</th><th>Recibo</th><th>Estado original</th><th>Proveedor / modelo real</th><th>Tokens</th><th>Predicted → winner / motivo</th></tr>'+receiptRows+'</table>')+
    section('USL y límites',pre(bundle.artifacts['usl-demo']))+'<footer>'+e(provenance)+' · '+e(run.runId)+' · Archivo estático, sin red ni recursos externos.</footer></html>';
}
export function writeReport(id:string,run:any,bundle:any,subdir='') {
  const relative=`out/${id}/${subdir?subdir+'/':''}report.html`,file=path.join(ROOT,relative);
  fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,scrub(reportHtml(id,run,bundle)));
  return relative;
}