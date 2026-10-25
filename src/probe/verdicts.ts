import fs from 'node:fs';
import path from 'node:path';
import { readJson, ROOT, sanitize, writeJson } from '../runtime.ts';
import type { Probe } from './index.ts';
import type { EvidenceBundle, RelationContract } from '../contracts/types.ts';
import { evaluateRelation } from '../relations/decision.ts';
import { relationPolicyFromConfig } from '../relations/policy.ts';
import { legacyProbeToEvidence } from '../relations/legacy.ts';
import { resolveUniverseManifest } from '../registry/universes.ts';
export type Verdict = 'SOSTENIDA' | 'ENGAÑOSA' | 'INDETERMINADA';
export function classify(p: Probe, thresholds: any): { verdict: Verdict; rule: string };
export function classify(p: RelationContract, input: { evidence: readonly EvidenceBundle[]; policyVersion: string; minimumDistinctKeys?: number }): { verdict: Verdict; rule: string };
export function classify(p: Probe | RelationContract, thresholds: any): { verdict: Verdict; rule: string } {
  if ('schemaVersion' in p && 'evidencePolicy' in p) {
    const decision = evaluateRelation(p, thresholds.evidence, relationPolicyFromConfig(thresholds));
    return { verdict: decision.verdict, rule: decision.reasonCodes[0] ?? 'contract_policy' };
  }
  if ('relation' in p && Array.isArray(p.queries)) {
    if (!thresholds.universeId) throw new TypeError('LEGACY_PIPELINE_UNIVERSE_CONTEXT_REQUIRED');
    if (!thresholds.relationPolicyVersion) throw new TypeError('RELATION_POLICY_VERSION_REQUIRED');
    if (!thresholds.contractVersion) throw new TypeError('RELATION_CONTRACT_VERSION_REQUIRED');
    const adapted = legacyProbeToEvidence(p, thresholds.universeId, thresholds, { contractVersion: thresholds.contractVersion, executionMode: thresholds.executionMode ?? 'UNKNOWN', dataOrigin: thresholds.dataOrigin ?? 'UNKNOWN' });
    const decision = evaluateRelation(adapted.contract, [adapted.evidence], relationPolicyFromConfig(thresholds));
    return { verdict: decision.verdict, rule: decision.reasonCodes[0] ?? 'contract_policy' };
  }
  throw new TypeError('TYPED_RELATION_EVIDENCE_REQUIRED');
}
export function verdicts() {
  const { probes } = readJson<{ probes: Probe[] }>('out/U1/probes.json');
  const thresholds = readJson('config/thresholds.json');
  const relations = probes.map(p => {
    const baseDecision = p.decision ? { verdict: p.decision.verdict, rule: p.decision.reasonCodes[0] ?? 'contract_policy' } : classify(p, { ...thresholds, universeId: 'U1', contractVersion: resolveUniverseManifest('U1')!.version.split('.').slice(0, 2).join('.') });
    const decision = p.freshness?.state==='DEGRADADA'?{verdict:'INDETERMINADA' as const,rule:'freshness_changed_requires_review'}:
      p.freshness?.state==='INCOMPLETA'?{verdict:'INDETERMINADA' as const,rule:'transport_incomplete'}:baseDecision;
    const explanation = `${decision.verdict}: ${p.overlap.matched}/${p.overlap.probed} claves distintas observadas coinciden; etiquetas ${p.labelAgreement ? p.labelAgreement.agree + '/' + p.labelAgreement.compared : 'no comparables (ausentes)'}. Tipos ${p.typeCompat.from}/${p.typeCompat.to}; compatibles=${p.typeCompat.castable}. Nulos de la muestra fuente=${p.nullRate.from ?? 'sin filas'}. ${p.alerts.join('; ')}. Evidencia acotada, sin garantía global de identidad, unicidad o cobertura.`;
    return { relationId: p.relation.id, from: p.relation.from, to: p.relation.to, proposedBy: p.relation.proposedBy, ...decision,
      proposedBySources: p.relation.proposedBySources ?? [p.relation.proposedBy], llmProposalReceiptId: p.relation.llmReceiptId,
      evidenceId: p.relation.id, decision: p.decision, explanation, explanationSource: 'deterministic-template', pending_llm: true, evidence: p, freshness:p.freshness };
  });
  const output = { utc: new Date().toISOString(), liveEvidence: true, pending_llm: true, thresholds, relations };
  writeRelations(output);
  console.log('Verdictos:', Object.fromEntries(['SOSTENIDA','ENGAÑOSA','INDETERMINADA'].map(v => [v, relations.filter(r => r.verdict === v).length])), 'pending_llm');
  return output;
}
export function writeRelations(output: any,id='U1') {
  const relations: any[] = output.relations;
  writeJson(`out/${id}/relaciones.json`, output);
  const editorialCount = relations.filter(r => r.llmExplanation).length;
  const lines = [`# ${id} — relaciones verificadas con muestras`, '', output.pending_llm ? 'Explicaciones LLM: pending_llm.' : `Explicaciones: ${editorialCount} redactadas con Nightshift y ${relations.length - editorialCount} de plantilla determinista. Veredictos calculados de forma determinista.`,
    'Las sondas corresponden a las fechas de sus consultas registradas; no se presentan las muestras conservadas como consultas nuevas. Sin joins remotos ni garantía de integridad global.', '', '| Relación | Veredicto | Vigencia | Claves | Etiquetas | Revisión |', '|---|---|---|---:|---:|---|'];
  for (const r of relations) lines.push(`| ${r.relationId} | ${r.verdict} | ${r.freshness?.state??'no disponible'} | ${r.evidence.overlap.matched}/${r.evidence.overlap.probed} | ${r.evidence.labelAgreement ? r.evidence.labelAgreement.agree + '/' + r.evidence.labelAgreement.compared : 'ausentes'} | ${r.decision?.requiresReview||r.requiresReview||r.freshness?.requiresReview?'sí':'no'} |`);
  for (const r of relations) {
    lines.push('', `## ${r.relationId}`, '', ...(r.critic?.status==='DEGRADED'?[`Veredicto actual: ${r.verdict} por crítico (${r.critic.reason}); requiere revisión=${Boolean(r.decision?.requiresReview??r.requiresReview)}. La explicación y sonda siguientes corresponden a evidencia base CACHED ${r.evidence?.utc}; se conservan como historial.`,'']:[]),r.explanation,'',`Vigencia: ${r.freshness?.state??'no disponible'}; observada ${r.freshness?.observedAt??r.evidence?.utc??'sin fecha'}; requiere revisión=${Boolean(r.decision?.requiresReview||r.requiresReview||r.freshness?.requiresReview)}.`,'','Regla: ' + r.rule, '');
    if (r.llmExplanation) lines.push('', 'Redacción Nightshift: ' + r.llmExplanation, '', 'Recibo: ' + r.llmReceipt.receiptId);
    else lines.push('Origen de explicación: ' + r.explanationSource, ...(r.explanationCompletionReason ? [r.explanationCompletionReason] : []));
    for (const example of r.evidence.labelAgreement?.examples.slice(0, 3) ?? []) lines.push(`- Clave ${example.key}: ${example.fromLabel.join(' / ')} ↔ ${example.toLabel.join(' / ')}; acuerdo=${example.agrees}.`);
    for (const query of r.evidence.queries) lines.push('', 'Request ID: ' + query.requestId, '', '```sql', query.sql, '```');
    if (r.evidence.error) lines.push('', 'Error: ' + JSON.stringify(r.evidence.error));
  }
  if(output.critic){
    lines.push('','## Crítica adversarial','','Confirmadas: '+output.critic.confirmed+'; degradadas: '+output.critic.degraded+'; insuficientes: '+output.critic.insufficient+'; omitidas: '+output.critic.skipped+'.');
    for(const r of relations.filter((x:any)=>x.critic)){
      lines.push('',`### ${r.relationId}: ${r.critic.status}`,'',r.critic.reason??'');
      for(const c of r.critic.counterprobes??[])lines.push(`- ${c.strategy}; ${c.metrics?.matchedKeys??'—'}/${c.metrics?.seedKeys??'—'} claves coinciden; duplicados en la respuesta: ${c.metrics?.duplicateKeys?.length??0}; requestId ${c.requestId??'no disponible'}.`,'','```sql',c.sql,'```');
    }
  }
  fs.writeFileSync(path.join(ROOT, `out/${id}/relaciones.md`), sanitize(lines.join('\n')) + '\n');
  return output;
}
