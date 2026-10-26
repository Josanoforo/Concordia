import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SafeError } from '../runtime.ts';
import { escapeHtml, scrub } from './index.ts';
import { modelReviewOf, reviewOriginsOf, MODEL_REVIEW_BASIS } from './review-origin.ts';
import { normalizeArtifactsOrder, normalizeRunOrder } from './order.ts';
import { humanContractOf, publicHumanContract, humanContractSentence, loadNegativeControl, summarizeNegativeControl, insufficiencyNote, HUMAN_CONTRACT_BASIS, type HumanContract } from './human-contract.ts';
import { incompletenessOfDecision } from '../relations/incompleteness.ts';

// Reporte legible (MD + HTML) del run del agente generico. Solo lee engine-run.json (y artifacts.json si existe).
type Block =
  | { t: 'kv'; rows: [string, string][] }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'p'; text: string }
  | { t: 'list'; items: string[] };
type Section = { title: string; blocks: Block[] };

const NA = 'no disponible en este run';
const compact = (v: unknown, max = 400): string => { const s = JSON.stringify(v) ?? ''; return s.length > max ? s.slice(0, max) + '...' : s; };
const str = (v: unknown): string => v === undefined || v === null || v === '' ? '-' : typeof v === 'string' ? v : typeof v === 'object' ? compact(v) : String(v);
const arr = (v: unknown): any[] => Array.isArray(v) ? v : [];
const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};

const ref = (c: unknown): string => { const o = obj(c); return o.table === undefined ? '-' : `${str(o.db)}.${str(o.table)}.${str(o.column)}`; };
const of = (n: unknown, d: unknown): string => typeof n === 'number' && typeof d === 'number' && d > 0 ? `${n} de ${d}` : typeof n === 'number' ? `${n} (sin denominador)` : '-';

function coverageCell(cp: Record<string, any>): string {
  const r = obj(cp.result);
  if (cp.status === 'EXECUTED') return `${of(r.targetMatches, r.probedValues)} valores sondeados (${of(r.probedValues, r.sampledSourceValues)} muestreados)`;
  return cp.reason ? `${str(cp.status)}: ${str(cp.reason)}` : str(cp.status);
}
const POST_COMA_FULL_MAX = 50, COMA_TOP_N = 20, NOT_EXECUTED_TOP_N = 20;
/** priorRun (M7-2): resultados de una corrida previa que evitan re-sondear pares ya demostrados. */
function priorRunBlocks(prior: unknown): Block[] {
  if (prior === undefined) return [];
  const pr = obj(prior), skipped = arr(pr.skipped);
  if (pr.applied !== true) return [{ t: 'p', text: `Corrida previa (priorRun): no aplicada${pr.reason ? ` (${str(pr.reason)})` : ''}; no se omitio ninguna sonda.` }];
  const by = (o: string) => skipped.filter(x => x.outcome === o).length;
  return [{ t: 'p', text: `Corrida previa (priorRun): aplicada. ${skipped.length} propuestas omitidas por resultado previo (ACCEPTED ${of(by('ACCEPTED'), skipped.length)}; NEGATIVE ${of(by('NEGATIVE'), skipped.length)}).${skipped.length > 20 ? ' Se listan las 20 primeras; el resto esta en engine-run.json (postComa.priorRun.skipped).' : ''}` },
    ...(skipped.length ? [{ t: 'table', head: ['Propuesta', 'Resultado previo'], rows: skipped.slice(0, 20).map(x => [str(x.proposalId), str(x.outcome)]) } as Block] : [])];
}
function postComaBlocks(pc: unknown): Block[] {
  if (pc === undefined) return [{ t: 'p', text: `Post-COMA: ${NA}.` }];
  const p = obj(pc), proposals = arr(p.proposals), pol = obj(p.policy);
  if (!proposals.length && p.policy === undefined && p.counts === undefined) return [{ t: 'kv', rows: Object.entries(p).map(([k, v]): [string, string] => [k, str(v)]) }];
  const by = (st: string) => proposals.filter(x => obj(x.coverageProbe).status === st).length, c = obj(p.counts);
  const n = proposals.length, executed = c.executed ?? by('EXECUTED');
  const out: Block[] = [{ t: 'kv', rows: [['Estado', str(p.status)], ['Propuestas', String(n)], ['Sondas ejecutadas', of(executed, n)], ['No ejecutables', of(c.notExecutable ?? by('NOT_EXECUTABLE'), n)],
    ['Politica', `maximo ${str(pol.maxProbes)} sondas; costo ${str(pol.costPerProbe)} por sonda; orden: ${str(pol.ranking)}; igualdad: ${str(pol.equality)}${typeof pol.estimatedQueries === 'number' ? `; consultas estimadas ${pol.estimatedQueries}${typeof pol.queriesAvailable === 'number' ? ` de ${pol.queriesAvailable} disponibles en el presupuesto` : ''}` : ''}`]] }];
  out.push(...priorRunBlocks(p.priorRun), ...preEstimateBlocks(p));
  if (n > POST_COMA_FULL_MAX) {
    const exec = proposals.filter(x => obj(x.coverageProbe).status === 'EXECUTED');
    out.push({ t: 'p', text: `Universo ancho: ${n} propuestas. Sugeridas sin sonda por el tope de sondas: ${of(c.suggested ?? by('SUGGESTED'), n)}; no ejecutables: ${of(c.notExecutable ?? by('NOT_EXECUTABLE'), n)}; omitidas por presupuesto de consultas (SKIPPED_BUDGET): ${of(c.skippedBudget ?? by('SKIPPED_BUDGET'), n)}. Solo se listan las ${exec.length} sondas ejecutadas; el resto esta en engine-run.json (postComa.proposals).` });
    if (exec.length) out.push({ t: 'table', head: ['Propuesta', 'Desde', 'Hacia', 'Puntaje crudo', 'Cobertura de la sonda', 'Nivel', 'Sospechosa', 'Orientacion', 'Revision', 'Veredicto'], rows: exec.map(x => {
      const d = obj(obj(x.coverageProbe).diagnostic), sp = obj(d.suspect);
      return [str(x.proposalId), ref(x.from), ref(x.to), str(x.rawScore), coverageCell(obj(x.coverageProbe)), str(obj(d.coverage).level) || '-', sp.value === true ? `si: ${arr(sp.reasons).map(str).join(', ')}` : sp.value === false ? 'no' : '-', str(obj(x.structure).orientation) || '-', str(x.reviewState), str(x.verificationStatus)];
    }) });
  } else if (n) out.push({ t: 'table', head: ['Propuesta', 'Desde', 'Hacia', 'Puntaje crudo', 'Cobertura de la sonda', 'Revision', 'Veredicto'], rows: proposals.map(x => [str(x.proposalId), ref(x.from), ref(x.to), str(x.rawScore), coverageCell(obj(x.coverageProbe)), str(x.reviewState), str(x.verificationStatus)]) });
  if (arr(p.limitations).length) out.push({ t: 'list', items: arr(p.limitations).map(str) });
  return out;
}
// Eficiencia: datos destacados con denominador; el costo solo si el run o los recibos lo traen.
export function efficiencyRows(run: any): [string, string][] {
  const calls = arr(obj(obj(run.phases).exploration).calls), rc = calls.map(c => obj(c.receipt)).filter(r => r.receiptId), n = calls.length, dec = arr(run.decisions).length;
  const tokens = rc.reduce((t: number, r: any) => t + (typeof r.totalTokens === 'number' ? r.totalTokens : 0), 0);
  const lim = obj(obj(run.budget).limits), used = obj(obj(run.budget).used), q = used.queries, ql = lim.maxQueriesPerRun;
  const validRc = calls.filter(c => c.decisionStatus === 'VALID' && obj(c.receipt).receiptId).length;
  const costOf = (o: Record<string, any>) => Object.entries(o).filter(([k, v]) => /cost/i.test(k) && typeof v === 'number');
  const costs = [...costOf(obj(obj(run.budget).used)), ...costOf(obj(run)), ...rc.flatMap((r: any) => costOf(r))];
  return [
    ['Tokens del modelo', (typeof lim.maxTokensPerRun === 'number' ? of(tokens, lim.maxTokensPerRun) + ' del tope' : n ? `${tokens} (sin tope declarado)` : '0') + (typeof used.tokens === 'number' && used.tokens !== tokens ? `; suma de recibos, el contador del presupuesto registra ${used.tokens}` : '')],
    ['Tokens por decision del modelo', !n ? 'sin decisiones del modelo' : validRc ? `${Math.round(tokens / validRc)} (${tokens} tokens de ${rc.length} llamadas con recibo, entre ${validRc} decisiones validas con recibo; ${n} llamadas en total)` : `sin decisiones validas con recibo (${tokens} tokens en ${rc.length} llamadas con recibo de ${n})`],
    ['Generaciones (llamadas al modelo)', String(n)],
    ['Consultas SQL', typeof q === 'number' ? (typeof ql === 'number' ? of(q, ql) + ' del tope' : String(q)) : NA],
    ['SQL por relacion decidida', typeof q === 'number' && dec ? `${(q / dec).toFixed(1)} (${q} consultas en ${dec} relaciones)` : 'sin relaciones decididas'],
    ['Recibos', rc.length ? rc.map((r: any) => `${str(r.receiptId)} (${str(r.model)}, ${str(r.totalTokens)} tokens)`).join('; ') : 'sin recibos'],
    ['Costo', costs.length ? costs.map(([k, v]) => `${k}: ${v}`).join('; ') : 'costo no registrado en este run'],
  ];
}

// Metricas por etapa (D->V) con nombre fijo, para poder alinear dos runs fila contra fila.
export type StageMetric = [stage: string, metric: string, value: string];
export function stageMetrics(run: any, artifacts?: unknown): StageMetric[] {
  const ph = obj(run.phases), disc = obj(ph.discovery), coma = obj(ph.coma), expl = obj(ph.exploration), probes = obj(ph.probes), critic = obj(ph.critic);
  const calls = arr(expl.calls), actions = arr(expl.actions), decisions = arr(run.decisions), pc = obj(run.postComa), props = arr(pc.proposals);
  const tokens = calls.reduce((n: number, c: any) => n + (typeof obj(c.receipt).totalTokens === 'number' ? obj(c.receipt).totalTokens : 0), 0);
  const lim = obj(obj(run.budget).limits).maxTokensPerRun;
  const probeQueries = obj(artifacts).probes === undefined ? NA : String(arr(obj(artifacts).probes).reduce((n: number, x: any) => n + arr(obj(x.evidence).queries).length, 0));
  const verdicts = new Map<string, number>();
  for (const d of decisions) verdicts.set(str(d.verdict), (verdicts.get(str(d.verdict)) ?? 0) + 1);
  const rel = arr(disc.relations).length;
  return [
    ['D Discovery', 'Estado', str(disc.status)], ['D Discovery', 'Tablas', String(arr(disc.tables).length)], ['D Discovery', 'Relaciones configuradas', String(rel)],
    ['C COMA', 'Estado', str(coma.status)], ['C COMA', 'Candidatos', str(coma.candidates)], ['C COMA', 'Propuestas fuera de alcance', String(arr(coma.outOfScopeProposals).length)],
    ['P Post-COMA', 'Sondas ejecutadas', run.postComa === undefined ? NA : of(props.filter(x => obj(x.coverageProbe).status === 'EXECUTED').length, props.length)],
    ['X Exploracion', 'Llamadas validas', calls.length ? of(calls.filter(c => c.decisionStatus === 'VALID').length, calls.length) : 'sin llamadas'],
    ['X Exploracion', 'Tokens del modelo', typeof lim === 'number' ? of(tokens, lim) : calls.length ? `${tokens} (sin limite declarado)` : '0'],
    ['X Exploracion', 'Acciones ejecutadas', actions.length ? of(actions.filter(a => a.execution === 'PASS').length, actions.length) : 'sin acciones'],
    ['S Sondas', 'Relaciones sondeadas', rel ? of(arr(probes.selected).length, rel) : `${arr(probes.selected).length} (sin relaciones configuradas)`], ['S Sondas', 'Consultas de evidencia', probeQueries],
    ['V Veredictos', 'Veredictos', decisions.length ? [...verdicts].map(([k, v]) => `${k} ${of(v, decisions.length)}`).join('; ') : 'sin veredictos'],
    ['K Critica', 'Elegibles', decisions.length ? of(typeof critic.eligible === 'number' ? critic.eligible : undefined, decisions.length) : str(critic.eligible)],
  ];
}

// Memoria del agente (campo opcional `memory`; `reuse` y `revalidation` llegan despues y tambien son opcionales).
const REPROBE_TEXT: Record<string, string> = {
  NO_MEMORY: 'sin memoria de esta relacion: se sondea', NOT_SUSTAINED: 'la memoria no la sostenia: se sondea',
  VERSION_CHANGED: 'cambio la version de la fuente: se sondea de nuevo', EXPIRED: 'la observacion recordada vencio: se sondea de nuevo',
  INVALIDATED: 'el claim sostenido fue invalidado (directamente o por derivarse de otro): no se reutiliza y se sondea de nuevo',
  UNTRUSTED_PROVENANCE: 'el claim no trae run ni recibos de las consultas que lo respaldan: no se reutiliza y se sondea de nuevo',
};
/** Niveles y tiempos de los claims (R6 de memoria) y razones de re-sondeo; solo si el run los trae. */
function memoryTimeBlocks(m: any, run: any): Block[] {
  const out: Block[] = [], claims = arr(m.claims);
  const timed = claims.filter(c => c.tier !== undefined || c.validFrom !== undefined || c.recordedAt !== undefined || c.invalidated !== undefined);
  if (timed.length) {
    const span = (a: unknown, b: unknown) => `${a === undefined || a === null ? 'inicio desconocido' : str(a)} a ${b === undefined || b === null ? 'fin desconocido' : str(b)}`;
    out.push({ t: 'p', text: 'Nivel y tiempos de los claims (el nivel es solo una etiqueta: no ordena claims ni cambia decisiones):' },
      { t: 'table', head: ['Claim', 'Nivel', 'Reutilizado por', 'Vigencia en el mundo', 'Registro', 'Invalidado'],
        rows: timed.map(c => [str(c.id), str(c.tier) || '-', arr(c.reusedBy).length ? arr(c.reusedBy).map(str).join(', ') : '-', span(c.validFrom, c.validTo), span(c.recordedAt, c.supersededAt),
          c.invalidated === true ? `si, por ${str(c.invalidatedBy) || 'origen desconocido'}` : c.invalidated === false ? 'no' : '-']) });
  }
  const reprobe = arr(obj(m.reuse ?? run.reuse).reprobe);
  if (reprobe.length) out.push({ t: 'p', text: `Relaciones re-sondeadas en lugar de reutilizadas: ${reprobe.length}.` },
    { t: 'table', head: ['Relacion', 'Razon', 'Explicacion', 'Version recordada', 'Version actual'], rows: reprobe.map(r => [str(r.relationId), str(r.reason), REPROBE_TEXT[str(r.reason)] ?? '-', str(r.rememberedVersion) || '-', str(r.currentVersion) || '-']) });
  return out;
}

/** Claims de la memoria separados por el run que los escribio primero: nuevos de este run, previos de otro run, o sin firstRunId. */
export function claimsByOrigin(run: any): { total: number; fresh: number; previous: number; unknown: number } {
  const claims = arr(obj(run.memory).claims), id = str(run.runId);
  const fresh = claims.filter(c => c.firstRunId === id).length, previous = claims.filter(c => typeof c.firstRunId === 'string' && c.firstRunId !== id).length;
  return { total: claims.length, fresh, previous, unknown: claims.length - fresh - previous };
}
function memoryBlocks(run: any): Block[] {
  if (run.memory === undefined) return [{ t: 'p', text: `Memoria: ${NA}.` }];
  const m = obj(run.memory), claims = arr(m.claims), conflicts = arr(m.conflicts), queue = arr(m.reviewQueue), led = obj(m.ledger);
  const live = claims.filter(c => !c.superseded).length, cs = (st: string) => conflicts.filter(c => c.status === st).length;
  const out: Block[] = [{ t: 'kv', rows: [['Estado', str(m.status)], ['Alcance', str(m.scope)], ['Claims vigentes', of(live, claims.length)], ['Conflictos en cola', of(cs('queued'), conflicts.length)], ['Conflictos auto-resueltos', of(cs('auto_resolved'), conflicts.length)], ['Conflictos resueltos por humano', of(cs('human_resolved'), conflicts.length)],
    ['Bitacora', led.entries === undefined ? NA : `${str(led.entries)} entradas${led.appendOnly ? ' (solo anexo)' : ''}`], ...(m.reason ? [['Motivo', str(m.reason)] as [string, string]] : []), ...(m.error ? [['Error', str(m.error)] as [string, string]] : [])] }];
  if (claims.length) { const o = claimsByOrigin(run); out.push({ t: 'p', text: `Claims por origen: ${of(o.fresh, o.total)} escritos primero por este run; ${of(o.previous, o.total)} de runs previos${o.unknown ? `; ${of(o.unknown, o.total)} sin firstRunId (origen no registrado)` : ''}.` }); }
  const stale = queue.filter(q => q.kind === 'STALE_DEPENDENCY'), quarantined = queue.filter(q => q.kind === 'QUARANTINED_CLAIM'), queuedConflicts = queue.filter(q => q.kind !== 'STALE_DEPENDENCY' && q.kind !== 'QUARANTINED_CLAIM');
  out.push({ t: 'p', text: !queue.length ? 'Cola de revision humana: vacia.' : stale.length ? `Cola de revision humana: ${queue.length} items: ${queuedConflicts.length} de ${conflicts.length} conflictos esperan decision y ${stale.length} dependencias STALE esperan revision.` : `Cola de revision humana: ${queue.length} de ${conflicts.length} conflictos esperan decision.` });
  const b = obj(m.batch);
  if (Object.keys(b).length) { const th = obj(b.threshold), reasons = arr(b.reasons), codes = [...new Set(reasons.map(r => str(obj(r).code)))].sort();
    out.push({ t: 'p', text: `memoria: admitidos ${of(b.admitted, b.total)}, en cuarentena ${of(b.rejected, b.total)}${codes.length ? ` (razones: ${codes.join(', ')})` : ''}${typeof b.rejectedShare === 'number' ? `; proporcion rechazada ${b.rejectedShare}` : ''}${typeof th.maxRejectedShare === 'number' ? ` (maximo ${th.maxRejectedShare}, minimo de rechazados ${str(th.minRejected)})` : ''}; escritos ${of(b.written, b.total)}.${b.unhealthy ? ' El lote esta NO SANO (MEMORY_BATCH_UNHEALTHY): el run queda FAILED y el lote no se trata como memoria confiable.' : ''}` });
    if (reasons.length) out.push({ t: 'table', head: ['Relacion', 'Codigo', 'Razon'], rows: reasons.map(r => [str(obj(r).relationId), str(obj(r).code), str(obj(r).reason)]) }); }
  if (quarantined.length) out.push({ t: 'p', text: `Cola de revision humana de cuarentena: ${quarantined.length} claims en cuarentena esperan revision. Nunca son claims de la memoria.` }, { t: 'table', head: ['Relacion', 'Entidad', 'Codigo', 'Razon', 'Run'], rows: quarantined.map(q => [str(q.relationId), str(q.entity), str(q.code), str(q.reason), str(q.runId)]) });
  if (stale.length) out.push({ t: 'list', items: stale.map(q => `Revision pendiente: ${str(q.entity)}.${str(q.attribute)} quedo STALE porque ${str(q.causeClaimId)} fue ${str(q.reason)} (claim ${str(q.claimId)}; desde ${str(q.staleAt)}).`) });
  if (queuedConflicts.length) out.push({ t: 'table', head: ['Conflicto', 'Entidad', 'Atributo', 'Version', 'Claims', 'Estrategia'], rows: queuedConflicts.map(q => [str(q.conflictId), str(q.entity), str(q.attribute), str(q.version), arr(q.claimIds).map(str).join(', ') || '-', str(q.strategy)]) });
  if (conflicts.length) out.push({ t: 'table', head: ['Conflicto', 'Entidad', 'Atributo', 'Estado', 'Version', 'Ganador'], rows: conflicts.map(c => [str(c.id), str(c.entity), str(c.attribute), str(c.status), str(c.version), str(c.winner)]) });
  const history = conflicts.flatMap(c => arr(c.decisionHistory).map(h => [str(c.id), str(h.version), str(h.winner), str(h.correction), str(h.actor), str(h.reason), typeof h.at === 'number' && Number.isFinite(h.at) && h.at > 1e11 ? new Date(h.at).toISOString() : str(h.at)]));
  if (history.length) out.push({ t: 'p', text: `Historial de decisiones: ${history.length} decisiones en ${of(conflicts.filter(c => arr(c.decisionHistory).length).length, conflicts.length)} conflictos; cada fila conserva ganador, correccion, actor y razon de esa version.` }, { t: 'table', head: ['Conflicto', 'Version', 'Ganador', 'Correccion', 'Actor', 'Razon', 'Cuando'], rows: history });
  if (claims.length) out.push({ t: 'table', head: ['Claim', 'Relacion', 'Atributo', 'Valor', 'Regla', 'Fuente', 'Primer run', 'Runs', 'Vigente'], rows: claims.map(c => [str(c.id), str(c.relationId), str(c.attribute), str(c.value), str(c.rule), `${str(c.source)} ${str(c.sourceVersion)}`.trim(), str(c.firstRunId), String(arr(c.runIds).length), c.superseded ? `no (reemplazado por ${str(c.supersededBy)})` : 'si']) });
  out.push(...memoryTimeBlocks(m, run));
  for (const k of ['reuse', 'revalidation']) if (m[k] !== undefined || run[k] !== undefined) out.push({ t: 'kv', rows: Object.entries(obj(m[k] ?? run[k])).map(([a, b]): [string, string] => [`${k}.${a}`, str(b)]) });
  return out;
}

/** Control negativo (senuelos de X4): {artifact: null} = pendiente de aprobacion live; {artifact: nombre} = resultado en ese archivo del run; decoys[] = veredicto por senuelo (rechazado por evidencia o solo fuera del contrato). */
function negativeControlBlocks(nc: unknown): Block[] {
  if (nc === undefined) return [{ t: 'p', text: `Control negativo (senuelos): ${NA}.` }];
  const o = obj(nc), decoys = arr(o.decoys);
  if ('artifact' in o && (o.artifact === null || o.artifact === undefined) && !decoys.length) return [{ t: 'p', text: 'Control negativo (senuelos): pendiente de aprobacion live; todavia no hay resultado en este run.' }];
  const out: Block[] = [];
  if (typeof o.artifact === 'string') out.push({ t: 'p', text: `Control negativo (senuelos): resultado en ${o.artifact}.` });
  if (decoys.length) out.push({ t: 'p', text: `Control negativo (senuelos): ${decoys.length} senuelos evaluados${o.label ? ` (${str(o.label)}${typeof o.sqlSent === 'number' ? `; ${of(o.sqlSent, Number(o.sqlCeiling) || 0)} SQL del tope` : ''})` : ''}. REJECTED_BY_EVIDENCE: la evidencia misma lo rechaza. OUT_OF_CONTRACT_ONLY: la politica por si sola lo sostendria; solo el contrato humano lo deja fuera.` }, { t: 'table', head: ['Senuelo', 'Resultado', 'Base'], rows: decoys.map(d => { const x = obj(d); return [str(x.id), `${str(x.outcome ?? x.verdict)}${insufficiencyNote(x)}`, str(x.basis ?? x.reason ?? (x.hypotheticalVerdict ? `veredicto hipotetico ${str(x.hypotheticalVerdict)}${arr(x.reasonCodes).length ? ` (${arr(x.reasonCodes).map(str).join(', ')})` : ''}; ${x.inContract === true ? 'en el contrato' : 'fuera del contrato'}` : undefined))]; }) });
  return out.length ? out : [{ t: 'p', text: `Control negativo (senuelos): ${str(nc)}` }];
}

/** R-label: origen de la revision por relacion y, aparte, el rastro completo de la revision por modelo (jueces, ataques, tokens). */
function reviewOriginBlocks(run: any, artifacts: unknown): Block[] {
  const o = reviewOriginsOf(run, artifacts);
  if (!o.total || (o.counts.HUMAN_REVIEWED + o.counts.MODEL_REVIEWED + o.counts.BOTH === 0)) return [];
  return [{ t: 'p', text: 'HUMAN_REVIEWED es un contrato aprobado por el humano (seccion propia). MODEL_REVIEWED es ' + MODEL_REVIEW_BASIS + ' (seccion propia). No son equivalentes: la revision del modelo nunca ocupa un lugar que exige revision humana.' },
    { t: 'table', head: ['Origen de la revision', 'Relaciones decididas'], rows: [['HUMAN_REVIEWED', of(o.counts.HUMAN_REVIEWED, o.total)], ['MODEL_REVIEWED', of(o.counts.MODEL_REVIEWED, o.total)], ...(o.counts.BOTH ? [['HUMAN_REVIEWED y MODEL_REVIEWED', of(o.counts.BOTH, o.total)]] : []), ['sin revision registrada', of(o.counts.NONE, o.total)]] }];
}
const MODEL_REVIEW_REASONS: Record<string, string> = { BOTH_REQUIRES_HUMAN_CONTRACT: 'modo BOTH: el contrato de modelo se registra pero no se aplica, porque exige ademas el contrato humano', HUMAN_OVERLAY_ACTIVE: 'hay un overlay humano activo: el contrato de modelo no se aplica' };
function modelReviewBlocks(run: any, overlay?: unknown): Block[] {
  const mr = modelReviewOf(run, overlay);
  if (!mr) return [];
  const c = mr.counts, cand = c.candidates ?? 0, ev = mr.reviews.flatMap(r => r.evaluations.map(e => ({ r: r.relationId, ...e }))), at = mr.reviews.flatMap(r => r.attacks.map(a => ({ r: r.relationId, ...a })));
  const byOutcome = new Map<string, number>(); for (const a of at) byOutcome.set(a.outcome, (byOutcome.get(a.outcome) ?? 0) + 1);
  const label = mr.label === '-' ? MODEL_REVIEW_BASIS : mr.label, adversarial = label.includes('con pase adversarial');
  const out: Block[] = [{ t: 'p', text: label[0]!.toUpperCase() + label.slice(1) + ' (origen MODEL_REVIEWED). Los jueces evaluan cada candidata ciega' + (adversarial ? ' y un pase adversarial intenta refutar cada evaluacion' : '; el pase adversarial no se completo, por eso la revision no se rotula como adversarial') + '. Actua antes de las sondas de contrato y no cambia ningun veredicto: la politica determinista decide. No es revision humana ni sustituye la aprobacion de una persona.' }];
  if (/STAND_IN/.test(mr.provenance)) out.push({ t: 'p', text: 'Procedencia STAND_IN_OFFLINE: las respuestas vienen de un guion offline, no de un modelo; no cuenta como revision de modelo en un run LIVE.' });
  const why = mr.reason !== '-' ? (MODEL_REVIEW_REASONS[mr.reason] ?? mr.reason) : '-';
  out.push({ t: 'kv', rows: [['Estado de la etapa', mr.status + (why !== '-' ? ' (' + why + ')' : '')], ['Modo de revision requerido', mr.mode], ['Procedencia', mr.provenance],
    ['Candidatas revisadas', cand ? of(c.reviewed ?? mr.reviews.length, cand) : String(mr.reviews.length)], ['Aprobadas', of(c.approved ?? mr.approved.length, cand)], ['Aplazadas', of(c.deferred ?? 0, cand)], ['Rechazadas', of(c.rejected ?? 0, cand)], ['Sin revisar', of(c.notReviewed ?? 0, cand)],
    ['Aplicadas como contrato de modelo', mr.approved.length ? of(mr.applied.length, mr.approved.length) : String(mr.applied.length)], ['Evaluaciones de jueces', String(ev.length)],
    ['Ataques adversariales', at.length ? at.length + ' (' + [...byOutcome].map(([k, v]) => k + ' ' + of(v, at.length)).join('; ') + ')' : '0'], ['Llamadas al modelo', c.calls === undefined ? NA : String(c.calls)], ['Tokens de la revision', mr.tokens === null ? NA : String(mr.tokens)],
    ['Overlay del run', mr.overlayFile === '-' ? NA : mr.overlayFile + (mr.overlaySha256 !== '-' ? ' (sha256 ' + mr.overlaySha256.slice(0, 12) + ')' : '')], ['Estimacion de sondas del contrato de modelo', mr.estimate === undefined ? '-' : str(mr.estimate)]] });
  if (mr.reviews.length) out.push({ t: 'table', head: ['Relacion', 'Decision', 'Confianza', 'Pase adversarial', 'Ataques sobrevividos', 'Ataques sostenidos', 'Motivos', 'Tokens'], rows: mr.reviews.map(r => [r.relationId, r.decision, r.confidence, r.adversarialPass, String(r.survived), String(r.sustained), r.reasons, r.tokens === null ? '-' : String(r.tokens)]) });
  const sec = obj(obj(run.phases).candidateReview), h = obj(sec.health), cons = obj(sec.consistency);
  if (Object.keys(h).length) { const adv = obj(h.adversary), calls = h.calls;
    out.push({ t: 'kv', rows: [['Salud de la revision', [`llamadas ${str(calls)}`, `INVALID ${of(h.invalidCalls, calls)}`, `truncadas ${of(h.truncatedCalls, calls)}`, `omitidas por presupuesto ${of(h.skippedBudgetCalls, calls)}`, ...(typeof h.invalidCallShare === 'number' ? [`proporcion INVALID ${h.invalidCallShare}${typeof obj(h.thresholds).maxInvalidCallShare === 'number' ? ` (maximo ${obj(h.thresholds).maxInvalidCallShare})` : ''}`] : []), ...(Object.keys(adv).length ? [`adversario incompleto ${of(adv.incomplete, adv.attempted)}`] : []), ...(arr(h.codes).length ? [`codigos ${arr(h.codes).map(String).join(', ')}`] : [])].join('; ')]] } as any); }
  if (cons.status === 'OFF') out.push({ t: 'p', text: 'consistencia: OFF (no se aplico la consistencia global entre aristas).' });
  else if (cons.status === 'ERROR') out.push({ t: 'p', text: 'ATENCION: la consistencia global fallo (CONSISTENCY_FAILED); este run queda degradado.' });
  else if (cons.status === 'ENFORCED') { const dem = arr(cons.demoted), kept = arr(cons.kept).length;
    out.push({ t: 'p', text: `Consistencia global (ENFORCED): ${of(dem.length, dem.length + kept)} aristas degradadas a sin contrato, ${kept} conservadas, ${arr(cons.unresolved).length} sin resolver. Ningun veredicto se baja.` });
    if (dem.length) out.push({ t: 'table', head: ['Arista', 'Regla', 'Ganadora', 'Motivo'], rows: dem.map(d => [str(obj(d).id), str(obj(d).rule), str(obj(d).winner) || '-', str(obj(d).reason) || '-']) }); }
  const roles = new Map<string, { asked: Set<string>; got: Set<string>; calls: number; invalid: number; truncated: number; truncKnown: number; tokens: number | null }>();
  const roleOf = (role: string, c: { status: string; requestedModel: string; model: string; tokens: number | null; truncated: boolean | null }) => {
    const x = roles.get(role) ?? { asked: new Set<string>(), got: new Set<string>(), calls: 0, invalid: 0, truncated: 0, truncKnown: 0, tokens: null };
    if (c.requestedModel !== '-') x.asked.add(c.requestedModel); if (c.model !== '-') x.got.add(c.model);
    x.calls++; if (/INVALID/i.test(c.status)) x.invalid++; if (c.truncated !== null) { x.truncKnown++; if (c.truncated) x.truncated++; }
    if (c.tokens !== null) x.tokens = (x.tokens ?? 0) + c.tokens; roles.set(role, x);
  };
  for (const r of mr.reviews) { for (const e of r.evaluations) roleOf(e.judge, e); if (r.adversaryCall) roleOf('adversary', r.adversaryCall); }
  const ties = mr.reviews.filter(r => r.tieBreak && r.tieBreak.group.length > 1);
  if (ties.length) out.push({ t: 'p', text: `Desempate por estructura (X10): ${of(ties.filter(r => r.tieBreak!.decisive).length, ties.length)} grupos de empate se resuelven; el resto es no decisivo y sigue diferido. Pasos en orden: nombre contra tabla, cardinalidad distinta, cardinalidad de filas. La centralidad del destino es solo informacion y no decide.` },
    { t: 'table', head: ['Relacion', 'Grupo', 'Orden', 'Resultado', 'Rasgo decisivo', 'Centralidad (solo informacion)'],
      rows: ties.map(r => { const t = r.tieBreak!; return [r.relationId, String(t.group.length), t.ordered.join(' > ') || '-', t.decisive ? `decisivo, gana ${t.winner}` : `no decisivo${t.tied.length ? ` (empatadas: ${t.tied.join(', ')})` : ''}`, t.decisive ? `${t.decidedBy}: ${t.values}` : '-', t.centrality]; }) });
  if (roles.size) out.push({ t: 'p', text: `Modelos por rol (identificador real respondido; llamadas, INVALID y truncadas sobre las llamadas del rol):` }, { t: 'table', head: ['Rol', 'Modelo pedido', 'Modelo respondido', 'Llamadas', 'INVALID', 'Truncadas', 'Tokens'],
    rows: [...roles.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([role, x]) => [role, [...x.asked].sort().join(', ') || NA, [...x.got].sort().join(', ') || NA, String(x.calls), of(x.invalid, x.calls), x.truncKnown ? of(x.truncated, x.truncKnown) : NA, x.tokens === null ? NA : String(x.tokens)]) });
  if (ev.length) out.push({ t: 'table', head: ['Relacion', 'Juez', 'Estado', 'Decision del juez', 'Confianza', 'Motivos', 'Modelo pedido / respondido', 'Prompt (hash)', 'Tokens'], rows: ev.map(e => [e.r, e.judge, e.status, e.decision, e.confidence, e.reasons, e.requestedModel + ' / ' + e.model, e.promptHash.slice(0, 12), e.tokens === null ? '-' : String(e.tokens)]) });
  if (at.length) out.push({ t: 'table', head: ['Relacion', 'Ataque', 'Severidad', 'Recomienda', 'Resultado', 'Tokens'], rows: at.map(a => [a.r, a.family, a.severity, a.recommend, a.outcome, a.tokens === null ? '-' : String(a.tokens)]) });
  if (mr.notApproved.length) out.push({ t: 'table', head: ['Relacion', 'Decision', 'Revisada', 'Motivos'], rows: mr.notApproved.map(n => [n.relationId, n.decision, n.reviewed ? 'si' : 'no', n.reasons.join(', ') || '-']) });
  return out;
}
/** X7: medicion global (cobertura y unicidad sobre toda la tabla) guardada por sonda en evidence.fullEvidence; se muestra tal cual la entrega el modulo, sin reinterpretarla. */
function fullEvidenceBlocks(artifacts: unknown): Block[] {
  const rows = arr(obj(artifacts).probes).filter(p => obj(obj(p.evidence).fullEvidence) && Object.keys(obj(obj(p.evidence).fullEvidence)).length);
  if (!rows.length) return [];
  const all = arr(obj(artifacts).probes).length;
  const orphan = (p: any): string => {
    const cov = obj(obj(obj(p.evidence).fullEvidence).coverage), rw = obj(cov.rows);
    if (cov.status !== 'MEASURED') return `huerfanos: ${NA}`;
    const keys = `${of(cov.missing, cov.sourceDistinct)} claves distintas`;
    const byRows = Object.keys(rw).length ? `${of(rw.missingRows, rw.sourceNonNullRows)} filas${typeof rw.sourceNulls === 'number' && rw.sourceNulls > 0 ?` (mas ${rw.sourceNulls} filas con clave NULL, no huerfanas)` : ''}` : `filas no medidas${obj(cov.rowsNotMeasured).reason ? ` (${str(obj(cov.rowsNotMeasured).reason)})` : ''}`;
    return `huerfanos: ${keys}; ${byRows}`;
  };
  return [{ t: 'p', text: `Evidencia completa (medicion global sobre toda la tabla, no una muestra): ${of(rows.length, all)} relaciones. Cada fila es lo que midio la consulta global.` },
    { t: 'table', head: ['Relacion', 'Medicion'], rows: rows.map(p => [str(p.relationId), Object.entries(obj(obj(p.evidence).fullEvidence)).map(([k, v]) => `${k}: ${str(v)}`).join('; ')]) },
    { t: 'p', text: 'Huerfanos en dos semanticas (claves distintas del origen sin pareja en el destino, y filas del origen con clave no NULL sin pareja):' },
    { t: 'list', items: rows.map(p => `${str(p.relationId)}: ${orphan(p)}`) } as any];
}
/** P1: pre-estimacion del presupuesto de sondas (protege el presupuesto, no recorta por defecto). */
function preEstimateBlocks(pc: unknown): Block[] {
  const pe = obj(obj(pc).preEstimate ?? obj(obj(pc).policy).preEstimate);
  if (!Object.keys(pe).length) return [];
  return [{ t: 'p', text: 'Pre-estimacion del presupuesto de sondas (calculada antes de sondar; protege el presupuesto y no recorta candidatas por defecto):' }, { t: 'kv', rows: Object.entries(pe).map(([k, v]): [string, string] => [k, str(v)]) }];
}

/** Procedencia del contrato humano: aprobador, fecha y paquete; relaciones diferidas y resultado del control negativo cuando el run los trae. */
function humanContractBlocks(hc: HumanContract, run: any): Block[] {
  const ds = arr(run.decisions), inContract = (id: unknown) => !hc.relations.length || hc.relations.includes(String(id));
  const sustained = ds.filter(d => d.verdict === 'SOSTENIDA' && inContract(d.relationId)).length;
  const out: Block[] = [{ t: 'p', text: humanContractSentence(hc) },
    { t: 'kv', rows: [['Base del veredicto', HUMAN_CONTRACT_BASIS], ['Aprobador', hc.approver], ['Fecha de aprobacion', hc.approvedAt], ['Paquete o sesion', hc.session], ['Origen del overlay', hc.origin], ['Overlay sha256', hc.sha256], ['Cita de la aprobacion', hc.quote],
      ['Relaciones del contrato', hc.relations.length ? String(hc.relations.length) : NA], ['SOSTENIDA entre ellas', hc.relations.length ? of(sustained, hc.relations.length) : String(sustained)]] }];
  out.push(hc.deferred.length ? { t: 'p', text: `Relaciones diferidas, sin aprobar en este contrato: ${hc.deferred.length}.` } : { t: 'p', text: 'Relaciones diferidas: ninguna declarada en este run.' });
  if (hc.deferred.length) out.push({ t: 'table', head: ['Relacion', 'Razon'], rows: hc.deferred.map(d => [d.id, d.reason]) });
  out.push(...negativeControlBlocks(hc.negativeControl));
  return out;
}

function whyBlocks(run: any, artifacts: unknown): Block[] {
  const decisions = arr(run.decisions);
  if (!decisions.length) return [{ t: 'p', text: 'Sin veredictos que explicar.' }];
  const probes = new Map(arr(obj(artifacts).probes).map(x => [str(x.relationId), obj(x)]));
  const rows = decisions.map(d => {
    const a = probes.get(str(d.relationId)), ev = obj(a?.evidence), ov = obj(ev.overlap), fr = obj(a?.freshness);
    if (!a) return [str(d.relationId), str(d.verdict), arr(d.reasonCodes).map(str).join(', ') || '-', NA, NA, 'sin artifact de esta relacion'];
    const strategy = `propuesta: ${str(a.proposedBy)}; comparacion: ${str(a.normalization)}`;
    const alerts = arr(ev.alerts).map(str);
    const evidence = [ev.status === undefined ? undefined : `evidencia ${str(ev.status)}`, typeof ov.matched === 'number' ? `${of(ov.matched, ov.probed)} claves sondeadas coinciden` : undefined,
      `${arr(ev.queries).length} consultas`, fr.state === undefined ? undefined : `frescura ${str(fr.state)}`, alerts.length ? 'alertas: ' + alerts.join(', ') : undefined].filter(Boolean).join('; ');
    return [str(d.relationId), str(d.verdict), str(a.rule ?? arr(d.reasonCodes).map(str).join(', ')), strategy, evidence, str(a.explanation)];
  });
  return [{ t: 'table', head: ['Relacion', 'Veredicto', 'Regla que decidio', 'Estrategia', 'Evidencia', 'Explicacion'], rows },
    { t: 'p', text: 'El veredicto lo produce la politica determinista de la relacion; las propuestas de COMA y las elecciones del modelo no lo cambian.' }];
}
function artifactBlocks(run: any, artifacts: unknown): Block[] {
  if (run.artifactsFile === undefined) return [{ t: 'p', text: `Artifacts: ${NA}.` }];
  if (artifacts === undefined) return [{ t: 'p', text: `artifactsFile declarado (${path.basename(String(run.artifactsFile))}) pero el archivo no se pudo leer.` }];
  const a = obj(artifacts), out: Block[] = [{ t: 'table', head: ['Artifact', 'Contenido'], rows: Object.entries(a).map(([k, v]) => [k, Array.isArray(v) ? `${v.length} elementos` : v && typeof v === 'object' ? `${Object.keys(v).length} campos` : str(v)]) }];
  for (const [k, v] of Object.entries(a)) {
    const items = arr(v).filter(x => x && typeof x === 'object' && !Array.isArray(x));
    if (items.length && items.length === arr(v).length && items.every(x => 'relationId' in x)) {
      out.push({ t: 'p', text: `Detalle de ${k} (${items.length}):` }, { t: 'table', head: ['Relacion', 'Desde', 'Hacia', 'Veredicto', 'Regla', 'Normalizacion', 'Frescura', 'Explicacion'],
        rows: items.map(x => [str(x.relationId), ref(x.from), ref(x.to), str(x.verdict), str(x.rule), str(x.normalization), str(obj(x.freshness).state), str(x.explanation)]) });
    }
  }
  return out;
}

const INCOMPLETE_LABEL: Record<string, (d: any) => string> = {
  EXPECTED_SAMPLE_CAP: d => `truncada por el tope de muestra (LIMIT ${[...new Set(arr(d.cappedEndpoints).map(c => str(c.limit)))].join('/') || '?'})`,
  EXECUTION_FAILURE: () => 'incompleta por fallo de ejecucion',
  ENDPOINT_MISSING: d => `extremo ausente (${arr(d.missingEndpoints).map(str).join(', ') || '?'})`,
};
/** Tipo de incompletitud de cada sonda con evidence_incomplete_or_truncated: el campo guardado, o recalculado de lo guardado; si no, "no disponible". */
function incompletenessBlocks(artifacts: unknown): Block[] {
  const probes = arr(obj(artifacts).probes).filter(p => p && typeof p === 'object');
  const rows: string[][] = [];
  for (const p of probes) {
    const ev = obj(p.evidence), decision = ev.decision ?? p.decision;
    const incomplete = p.rule === 'evidence_incomplete_or_truncated' || arr(obj(decision).reasonCodes).includes('evidence_incomplete_or_truncated');
    if (!incomplete) continue;
    let inc = p.incompleteness ?? ev.incompleteness;
    if (inc === undefined) {
      try {
        const typed = ev.typedEvidence ?? p.typedEvidence, contract = ev.relationContract ?? p.relationContract;
        if (decision && contract && typed) inc = incompletenessOfDecision(decision, contract, Array.isArray(typed) ? typed : [typed]);
      } catch { inc = undefined; }
    }
    const kind = obj(inc).kind;
    rows.push([str(p.relationId), kind ? str(kind) : NA, kind ? (INCOMPLETE_LABEL[kind]?.(obj(obj(inc).detail)) ?? str(kind)) : 'no disponible']);
  }
  if (!rows.length) return [];
  return [{ t: 'p', text: `Tipo de incompletitud (${rows.length} sondas con evidencia incompleta o truncada; el veredicto no cambia):` }, { t: 'table', head: ['Relacion', 'Tipo', 'Lectura'], rows }];
}

/** Alternativas de union comparadas (R-02), si la corrida las trae; con denominador. */
function alternativesBlocks(run: any): Block[] {
  const stage = obj(obj(run.phases).joinComparison);
  if (stage.status === 'NOT_EXECUTED_BUDGET' || stage.status === 'ERROR') return [{ t: 'p', text: `Alternativas de union: ${stage.status === 'ERROR' ? 'error en la comparacion' : 'no ejecutadas por presupuesto'}.` }];
  const alts = arr(stage.alternatives).length ? arr(stage.alternatives) : arr(obj(run.joins).alternatives).length ? arr(obj(run.joins).alternatives) : arr(obj(obj(run.phases).exploration).alternatives).length ? arr(obj(obj(run.phases).exploration).alternatives) : arr(run.alternatives);
  if (!alts.length) return [];
  return [{ t: 'p', text: `Alternativas de union comparadas (${alts.length}):` }, { t: 'table', head: ['Alternativa', 'Desde', 'Hacia', 'Normalizacion', 'Filas origen con pareja', 'Pares', 'Ambiguas', 'Disponibilidad'],
    rows: alts.map(a => [str(a.choice), str(a.from), str(a.to), str(a.normalization), typeof a.matchedSourceRows === 'number' ? of(a.matchedSourceRows, a.nSource) : NA, str(a.matchPairs), str(a.ambiguousSourceRows), str(a.fieldAvailability)]) }];
}

/** Resumen derivado por el ejecutor para COMPARE_KEYS / AGGREGATE_COUNT (R-12). */
function actionSummary(a: any): string {
  const m = obj(obj(a.observation).summary);
  if (m.kind === 'COMPARE_KEYS') return `presentes ${of(arr(m.present).length, m.observedKeys)}; ausentes ${arr(m.missing).length}`;
  if (m.kind === 'AGGREGATE_COUNT') return `claves con filas ${of(m.keysWithRows, Number(m.keysWithRows) + arr(m.keysWithoutRows).length)}`;
  if (m.kind === 'BOUNDED_PROFILE') return `filas ${str(m.rows)}, distintos ${str(m.distinct)}, nulos ${str(m.nulls)} (${m.bounded === true ? 'acotado a' : 'bajo el'} LIMIT ${str(m.limit)})`;
  return '-';
}

/** Presupuesto por fase (opt-in, R5-3) y desglose de consultas al origen (M4-3); todo opcional. */
function budgetExtraBlocks(budget: any): Block[] {
  const out: Block[] = [], used = obj(budget.used), ph = obj(budget.phases), by = obj(ph.byPhase);
  if (typeof used.totalSourceQueries === 'number') {
    const gated = typeof used.queries === 'number' ? used.queries : 0, pre = typeof used.preflightQueries === 'number' ? used.preflightQueries : 0, disc = typeof used.discoveryQueries === 'number' ? used.discoveryQueries : 0;
    out.push({ t: 'p', text: `Consultas al origen: ${used.totalSourceQueries} en total = ${gated} con tope + ${pre} de preflight + ${disc} de descubrimiento (las dos ultimas no cuentan contra el tope).` });
  }
  const names = Object.keys(by);
  if (names.length) {
    const pair = (v: any) => (v && typeof v === 'object' ? `${str(v.queries)} consultas / ${str(v.tokens)} tokens` : '-');
    out.push({ t: 'p', text: ph.enabled === true ? 'Presupuesto por fase (activo; lo no usado pasa a la fase siguiente):' : 'Presupuesto por fase (sin reparto activo: solo se observa el uso):' },
      { t: 'table', head: ['Fase', 'Asignado', 'Transferido', 'Usado'], rows: names.map(n => [n, pair(by[n]?.allocated), pair(by[n]?.transferredIn), pair(by[n]?.used)]) });
  }
  return out;
}

/** Critico asistido por el modelo (R5-2), si el run lo trae: estado, recibo y relaciones degradadas. */
function criticAssistBlocks(run: any): Block[] {
  const a = obj(run.criticAssist);
  if (!a.status) return [];
  const rc = obj(obj(a.call).receipt), suggested = arr(a.suggested), executed = arr(a.executed), rejected = arr(a.rejected), degraded = arr(a.degradedRelationIds);
  return [{ t: 'kv', rows: [['Estado', str(a.status)], ['Llamada al modelo', obj(a.call).made === true ? 'si' : 'no'],
      ['Recibo', rc.receiptId ? `${str(rc.receiptId)} (${str(rc.model)}, ${str(rc.totalTokens)} tokens)` : 'sin recibo'],
      ['Contrapruebas sugeridas', String(suggested.length)], ['Ejecutadas', of(executed.length, suggested.length)], ['Rechazadas', String(rejected.length)],
      ['Relaciones degradadas', degraded.length ? of(degraded.length, arr(run.decisions).length) + ': ' + degraded.map(str).join(', ') : 'ninguna'],
      ...(a.fallback ? [['Respaldo', `critico determinista (${str(obj(a.fallback).reason)})`] as [string, string]] : [])] },
    { t: 'p', text: 'El modelo solo sugiere ids de contraprueba del catalogo; la regla del critico decide y solo puede bajar un veredicto.' }];
}

/** Cobertura y riesgo en formato de seleccion con abstencion; el riesgo solo se mide con adjudicacion (gold), que un run real no tiene. */
function coverageBlocks(run: any): Block[] {
  const ds = arr(run.decisions), total = ds.length;
  if (!total) return [{ t: 'p', text: 'Sin decisiones: no hay cobertura que calcular.' }];
  const count = (v: string) => ds.filter(d => d.verdict === v).length;
  const abst = count('INDETERMINADA'), decided = count('SOSTENIDA') + count('ENGAÑOSA');
  const dropped = arr(run.degradations).filter(d => d.code === 'RELATION_DROPPED_TABLE_ABSENT').map(d => str(d.detail));
  const cfg = arr(obj(obj(run.phases).discovery).relations).map(str), configured = cfg.length || dropped.length ? new Set([...cfg, ...dropped, ...ds.map(d => str(d.relationId))]).size : total;
  const undecided = Math.max(0, configured - total - dropped.filter(id => !ds.some(d => str(d.relationId) === id)).length), otherVerdicts = total - decided - abst;
  const verdicts = [...new Set(ds.map(d => str(d.verdict)))].sort();
  return [{ t: 'kv', rows: [
      ['Cobertura (decididas / relaciones configuradas)', of(decided, configured)],
      ['Tasa de abstencion (INDETERMINADA / relaciones configuradas)', of(abst, configured)],
      ...(undecided ? [['Sin decision (configuradas sin veredicto en este run)', of(undecided, configured)] as [string, string]] : []),
      ...(dropped.length ? [['Descartadas por tabla ausente (RELATION_DROPPED_TABLE_ABSENT)', of(dropped.length, configured)] as [string, string]] : []),
      ...(otherVerdicts ? [['Otros veredictos (ni decididos ni abstencion)', of(otherVerdicts, configured)] as [string, string]] : []),
      ['Riesgo (falsas aceptaciones / aceptadas)', `no medible sin adjudicacion (${of(count('SOSTENIDA'), configured)} aceptadas)`]] },
    { t: 'table', head: ['Veredicto', 'Relaciones'], rows: verdicts.map(v => [v, of(count(v), configured)]) },
    { t: 'p', text: 'Decidida = SOSTENIDA o ENGAÑOSA; abstencion = INDETERMINADA; el denominador son las relaciones configuradas del universo (incluidas las descartadas por tabla ausente), no solo las que llegaron a decision. El riesgo requiere una adjudicacion externa; la medicion con gold esta en eval-agent. Es solo reporte: no cambia ninguna decision.' }];
}

/** Telemetria por llamada al modelo (recibo, ruta pedida y ruteada, tokens, latencia, cache); solo si alguna llamada trae recibo. */
function telemetryBlocks(calls: any[]): Block[] {
  const withReceipt = calls.filter(c => obj(c.receipt).receiptId);
  if (!withReceipt.length) return [];
  const dash = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : str(v));
  const rows = withReceipt.map(c => {
    const r = obj(c.receipt);
    const requested = dash(r.requestedMode ?? c.requestedModel), routed = r.routedMode === undefined && r.winner === undefined ? '-' : `${dash(r.routedMode)}${r.winner ? ` (${str(r.winner)})` : ''}${r.modeCoerced === true ? ', modo forzado' : ''}`;
    return [dash(c.stage), str(r.receiptId), `${dash(r.provider)} / ${dash(r.model)}`, requested, routed, `${dash(r.routingReason)}${r.routingPolicy ? ` (${str(r.routingPolicy)})` : ''}`,
      `${dash(r.inputTokens)} / ${dash(r.outputTokens)}`, typeof r.latencyMs === 'number' ? `${r.latencyMs} ms` : '-', r.fromCache === true ? 'si' : r.fromCache === false ? 'no' : '-'];
  });
  return [{ t: 'table', head: ['Etapa', 'Recibo', 'Proveedor / modelo', 'Ruta pedida', 'Ruta ruteada', 'Razon de ruteo', 'Tokens (entrada / salida)', 'Latencia', 'Cache'], rows }];
}

/** Explicaciones escritas por el modelo (llmExplanation + recibo); se muestran aparte y rotuladas, nunca como causa del veredicto. */
function explanationBlocks(artifacts: unknown): Block[] {
  const items = arr(obj(artifacts).probes).filter(p => p && typeof p.llmExplanation === 'string' && p.llmExplanation);
  if (!items.length) return [];
  return [{ t: 'p', text: 'No decisoria: el texto lo escribio el modelo despues de fijado el veredicto; el veredicto lo produce la politica determinista y estas explicaciones no lo cambian ni lo causan.' },
    { t: 'table', head: ['Relacion', 'Recibo', 'Modelo', 'Explicacion del modelo (no decisoria)'], rows: items.map(p => [str(p.relationId), str(obj(p.llmReceipt).receiptId) || 'sin recibo', str(obj(p.llmReceipt).model) || '-', str(p.llmExplanation)]) }];
}

/** Base de las claves del origen: la muestra de descubrimiento o las claves distintas globales (F4). Campo ausente = no se dice nada (X4 `multiplicity.from.fromBasis`, X8 `sourceKeys.basis`). */
const basisText = (b: unknown): string => b === undefined || b === null ? '' : `; claves base: ${/GLOBAL|F4/i.test(str(b)) ? 'claves distintas globales (F4)' : /DISCOVERY|SAMPLE/i.test(str(b)) ? 'muestra de descubrimiento' : str(b)}`;
/** Candidatas del post-COMA ciego (diagnostic por sonda EXECUTED): ordenadas HIGH sin sospecha, LABEL_CONFLICT, resto. Nunca son veredicto. */
function candidateBlocks(pc: unknown): Block[] {
  const proposals = arr(obj(pc).proposals).filter(x => obj(obj(x.coverageProbe).diagnostic).governance !== undefined || obj(obj(x.coverageProbe).diagnostic).coverage !== undefined);
  if (!proposals.length) return [];
  const group = (d: any) => (d.coverage?.level === 'HIGH' && d.suspect?.value !== true ? 0 : d.labels?.signal === 'LABEL_CONFLICT' ? 1 : 2);
  const sorted = proposals.map((x, i) => ({ x, i, d: obj(obj(x.coverageProbe).diagnostic) })).sort((a, b) => group(a.d) - group(b.d) || (Number(b.x.rawScore) || 0) - (Number(a.x.rawScore) || 0) || a.i - b.i);
  const rows = sorted.map(({ x, d }) => {
    const cov = obj(d.coverage), lab = obj(d.labels), mult = obj(d.multiplicity), cont = obj(d.containment), kr = obj(d.keyRules), inc = obj(kr.inclusion), uq = obj(kr.targetUniqueness);
    const ref = (e: any) => `${str(obj(e).table)}.${str(obj(e).column)}`;
    return [`${ref(x.from)} -> ${ref(x.to)}`,
      `${str(cov.level)}: ${of(cov.matched, cov.probed)} valores; umbral ${cov.threshold === null || cov.threshold === undefined ? 'no disponible' : str(cov.threshold)}`,
      lab.compared !== undefined ? `${str(lab.signal)}: ${of(lab.agree, lab.compared)} etiquetas` : `${str(lab.signal)}${lab.reason ? ` (${str(lab.reason)})` : ''}`,
      `origen max ${str(obj(mult.from).maxRowsPerKey)} filas por clave; destino max ${str(obj(mult.to).maxRowsPerKey)}${basisText(obj(mult.from).fromBasis ?? mult.fromBasis)}`,
      cont.aToB ? `origen en destino: ${of(obj(cont.aToB).shared, obj(cont.aToB).of)}${cont.reason ? ` (${str(cont.reason)})` : ''}` : str(cont.reason) || '-',
      `inclusion ${str(inc.status)} (${of(inc.missingCount, inc.checkedKeys)} ausentes); unicidad destino ${str(uq.status)} (${str(uq.duplicateKeyCount)} claves repetidas)`,
      d.suspect?.value === true ? `si: ${arr(d.suspect.reasons).map(str).join(', ')}` : 'no',
      str(d.counterfactual) || '-'];
  });
  return [{ t: 'p', text: `candidata, no veredicto: CANDIDATE_REQUIRES_REVIEW. ${rows.length} candidatas descubiertas por el post-COMA ciego; siguen NO VERIFICADO/UNKNOWN y PENDING. Orden: cobertura HIGH sin sospecha, luego LABEL_CONFLICT, luego el resto.` },
    { t: 'table', head: ['Par', 'Cobertura', 'Etiquetas', 'Multiplicidad', 'Contencion', 'Reglas de clave', 'Sospechosa', 'Contrafactual'], rows }];
}

/** Hallazgo de calidad de datos: columnas destino con claves repetidas en la muestra acotada de las sondas ejecutadas (p. ej. catalog_page.cp_catalog_page_sk). No refuta las relaciones que la apuntan. */
function dataQualityBlocks(pc: unknown): Block[] {
  const by = new Map<string, { sources: Set<string>; probes: number; dupKeys: number; maxRows: number; rows: number }>();
  for (const x of arr(obj(pc).proposals)) {
    const cp = obj(x.coverageProbe), uq = obj(obj(obj(cp.diagnostic).keyRules).targetUniqueness);
    if (cp.status !== 'EXECUTED' || uq.status !== 'DUPLICATES_OBSERVED') continue;
    const key = `${str(obj(x.to).table)}.${str(obj(x.to).column)}`, cur = by.get(key) ?? { sources: new Set<string>(), probes: 0, dupKeys: 0, maxRows: 0, rows: 0 };
    cur.sources.add(`${str(obj(x.from).table)}.${str(obj(x.from).column)}`); cur.probes++; cur.dupKeys = Math.max(cur.dupKeys, Number(uq.duplicateKeyCount) || 0); cur.maxRows = Math.max(cur.maxRows, Number(uq.maxRowsPerKey) || 0); cur.rows = Math.max(cur.rows, Number(uq.rows) || 0);
    by.set(key, cur);
  }
  if (!by.size) return [];
  const executed = arr(obj(pc).proposals).filter(x => obj(x.coverageProbe).status === 'EXECUTED').length;
  return [{ t: 'p', text: `Columnas destino con claves repetidas en la muestra acotada: ${by.size}. Es un hallazgo de calidad de datos (TARGET_NOT_UNIQUE), no una refutacion de las relaciones que las apuntan; observado en ${of(Array.from(by.values()).reduce((s, v) => s + v.probes, 0), executed)} sondas ejecutadas.` },
    { t: 'table', head: ['Columna destino', 'Claves repetidas', 'Max filas por clave', 'Filas leidas', 'Sondas que lo observan', 'Origenes'], rows: [...by].map(([col, v]) => [col, String(v.dupKeys), String(v.maxRows), String(v.rows), String(v.probes), [...v.sources].join(', ')]) }];
}

/** Candidatas ejecutables que no tuvieron sonda por tope de sondas o de consultas, en orden de ranking. */
function notExecutedBlocks(run: any): Block[] {
  const list = arr(obj(run.postComa).notExecutedByBudget).length ? arr(obj(run.postComa).notExecutedByBudget) : arr(run.notExecutedByBudget);
  if (!list.length) return [];
  const pc = obj(run.postComa), n = arr(pc.proposals).length, executed = obj(pc.counts).executed ?? arr(pc.proposals).filter(x => obj(x.coverageProbe).status === 'EXECUTED').length;
  const reasons = new Map<string, number>(); for (const x of list) reasons.set(str(x.reason), (reasons.get(str(x.reason)) ?? 0) + 1);
  const wide = list.length > NOT_EXECUTED_TOP_N, shown = wide ? list.slice(0, NOT_EXECUTED_TOP_N) : list;
  return [{ t: 'p', text: `No ejecutadas por presupuesto: ${list.length}. Ejecutadas ${of(executed, n)} propuestas.${wide ? ` Razones: ${[...reasons].map(([r, c]) => `${r} ${of(c, list.length)}`).join('; ')}. Se listan las ${NOT_EXECUTED_TOP_N} primeras en orden de ranking; el resto esta en engine-run.json (postComa.notExecutedByBudget).` : ''}` },
    { t: 'table', head: ['Propuesta', 'Puntaje crudo', 'Razon'], rows: shown.map(x => [str(x.proposalId), str(x.rawScore), str(x.reason)]) }];
}

/** modelRanking declarado frente a las llamadas de ranking registradas (probeSelection.calls); solo devuelve texto si se contradicen. */
function rankingCell(ps: Record<string, any>): string | undefined {
  const n = arr(ps.calls).length;
  if (ps.modelRanking === 'USED' && n === 0) return 'usado (inconsistente: el run declara USED pero no registra llamadas de ranking en probeSelection.calls)';
  if (ps.modelRanking === 'NOT_USED' && n > 0) return `no usado (inconsistente: el run declara NOT_USED pero registra ${n} llamadas de ranking)`;
  return undefined;
}
/** Banner de primer nivel cuando el modelo fue pedido y no participo; una linea neutra si no se pidio (--no-model). Runs viejos: se infiere de plannerError o de llamadas vacias. */
export function modelParticipationOf(run: any): { state: string; explicit: string | undefined } {
  const expl = obj(obj(run.phases).exploration), pe = expl.plannerError, calls = arr(expl.calls), explicit = typeof run.modelParticipation === 'string' ? run.modelParticipation : undefined;
  const noModelAsked = run.modelRequested === false || arr(run.degradations).some(d => d.code === 'NO_MODEL_REQUESTED');
  // Runs sin modelParticipation: la falta de llamadas no es un fallo si el run fue --no-model o corrio offline (LOCAL/REPLAY).
  const inferred = pe !== undefined && pe !== null ? 'FAILED' : calls.length > 0 ? 'USED' : noModelAsked ? 'NOT_REQUESTED' : run.executionMode === 'LOCAL' || run.executionMode === 'REPLAY' ? 'SCRIPTED_OFFLINE' : 'FAILED';
  return { state: explicit ?? inferred, explicit };
}
function modelParticipationBlocks(run: any, expl: any): Block[] {
  const pe = expl.plannerError, calls = arr(expl.calls), { state, explicit } = modelParticipationOf(run);
  const out: Block[] = [];
  // Lo declarado se cruza con las llamadas registradas: una contradiccion se muestra, no se oculta.
  if (explicit === 'USED' && calls.length === 0) out.push({ t: 'p', text: 'Inconsistencia: el run declara modelParticipation USED pero no registra ninguna llamada al modelo (phases.exploration.calls vacio).' });
  if ((explicit === 'NOT_REQUESTED' || explicit === 'FAILED') && calls.some(c => c.decisionStatus === 'VALID')) out.push({ t: 'p', text: `Inconsistencia: el run declara modelParticipation ${explicit} pero registra ${calls.filter(c => c.decisionStatus === 'VALID').length} de ${calls.length} llamadas con decision valida.` });
  if (state === 'SCRIPTED_OFFLINE') out.push({ t: 'p', text: 'Chooser de script offline, sin modelo: las elecciones vienen de un guion, no de una generacion.' });
  else if (state === 'NOT_REQUESTED') out.push({ t: 'p', text: 'El modelo no fue solicitado en este run (--no-model).' });
  else if (state !== 'USED' && !(explicit === 'FAILED' && calls.some(c => c.decisionStatus === 'VALID'))) {
    const o = obj(pe), reason = run.modelParticipationReason ?? o.code ?? (typeof pe === 'string' ? pe : undefined) ?? 'sin llamadas al modelo registradas';
    const detail = o.code === 'TOKEN_BUDGET_WOULD_EXCEED' ? ` (estimado ${str(o.estimated)} tokens, limite ${str(o.limit)}, usados ${str(o.used)})` : '';
    out.push({ t: 'p', text: `El modelo NO participo: ${str(reason)}${detail}. Los veredictos vienen de la politica determinista, sin exploracion del modelo.` });
  }
  const pb = obj(run.publicBenchmark);
  if (state === 'USED' && typeof pb.name === 'string' && pb.name) {
    out.push({ t: 'p', text: `Universo de benchmark publico (${pb.name}): el modelo puede reconocer el esquema por los nombres. Los veredictos los decide la politica determinista con la evidencia acotada del run; el conocimiento previo del modelo solo puede influir en que acciones elige explorar.` });
    if (typeof pb.note === 'string' && pb.note) out.push({ t: 'p', text: `Nota del manifiesto: ${pb.note}` });
  }
  const deg = arr(run.degradations);
  const reviewDeg = deg.filter(d => /^MODEL_REVIEW_/.test(str(d.code)));
  if (reviewDeg.length) out.push({ t: 'p', text: `ATENCION: la revision por modelo de este run quedo degradada (${reviewDeg.map(d => `${str(d.code)}${countsText(d, obj(obj(run.phases).candidateReview).health)}`).join('; ')}). Este run no se lee como limpio: las relaciones afectadas no tienen la revision completa.` });
  if (deg.length) out.push({ t: 'p', text: `Degradaciones: ${deg.length}.` }, { t: 'table', head: ['Fase', 'Codigo', 'Detalle'], rows: deg.map(d => [str(d.phase), str(d.code), str(d.detail) || '-']) });
  return out;
}

/** Conteos de una degradacion: d.counts (numeros) o d.count; sin ellos no se inventa ninguno. */
const countsText = (d: any, h: Record<string, any> = {}): string => { const c = Object.keys(obj(d.counts)).length ? obj(d.counts) : { calls: h.calls, invalidCalls: h.invalidCalls, truncatedCalls: h.truncatedCalls, skippedBudgetCalls: h.skippedBudgetCalls }, e = Object.entries(c).filter(([, v]) => typeof v === 'number'); if (e.length) return ` [${e.map(([k, v]) => `${k}: ${v}`).join(', ')}]`; return typeof d.count === 'number' ? ` [${d.count}]` : ''; };
const DECISION_LOG = 'adaptive-decisions.jsonl';
function loadNegativeControlSummary(dir: string, run: any): unknown {
  const nc = obj(obj(run.reviewOverlay).negativeControl), artifact = loadNegativeControl(dir, nc);
  return artifact === undefined ? undefined : summarizeNegativeControl(artifact);
}
export type ReportOpts = { decisionLog?: any[]; negativeControl?: unknown; modelReviewOverlay?: unknown };
export function buildAgentRunSections(rawRun: any, rawArtifacts?: unknown, opts: ReportOpts = {}): Section[] {
  const run = normalizeRunOrder(rawRun), artifacts = normalizeArtifactsOrder(rawArtifacts);
  const s: Section[] = [];
  const phases = obj(run.phases), disc = obj(phases.discovery), coma = obj(phases.coma), expl = obj(phases.exploration), probes = obj(phases.probes), critic = obj(phases.critic);
  const budget = obj(run.budget), limits = obj(budget.limits), used = obj(budget.used);

  const part = modelParticipationBlocks(run, expl);
  if (part.length) s.push({ title: 'Participacion del modelo', blocks: part });
  const origin = reviewOriginBlocks(run, artifacts);
  if (origin.length) s.push({ title: 'Origen de la revision', blocks: origin });
  const hc = humanContractOf(run, artifacts);
  if (hc) { const pub = publicHumanContract(hc); s.push({ title: 'Contrato semantico aprobado por el humano', blocks: humanContractBlocks(opts.negativeControl === undefined ? pub : { ...pub, negativeControl: opts.negativeControl }, run) }); }
  const rs = obj(run.resume);
  if (Object.keys(rs).length) s.push({ title: 'Reanudacion', blocks: [{ t: 'p', text: `reanudada tras ${str(rs.interruptions)} interrupciones: ${str(rs.resumedProbes)} sondas reusadas, ${str(rs.newProbes)} nuevas${rs.journalFound === false ? ' (no se encontro el diario: no se reuso nada)' : ''}. Limite declarado: solo se reanuda el post-COMA. No degrada el run.` }] });
  s.push({ title: 'Estado final', blocks: [{ t: 'kv', rows: [['Estado', str(run.status)], ['Decisiones deterministas', String(arr(run.decisions).length)], ['Limitaciones declaradas', String(arr(run.limitations).length)]] },
    ...(arr(run.limitations).length ? [{ t: 'list', items: arr(run.limitations).map(str) } as Block] : [])] });

  s.push({ title: 'Eficiencia', blocks: [{ t: 'kv', rows: efficiencyRows(run) }] });

  const limitKey = (u: string) => { const cap = u[0].toUpperCase() + u.slice(1); return [u, 'max' + cap + 'PerRun', 'max' + cap].find(k => k in limits); };
  const rows: string[][] = [], seen = new Set<string>();
  for (const u of Object.keys(used)) { const lk = limitKey(u); if (lk) seen.add(lk); rows.push([u, str(used[u]), lk ? str(limits[lk]) : '-', lk && typeof limits[lk] === 'number' ? `${used[u]} de ${limits[lk]}` : 'sin limite declarado']); }
  for (const l of Object.keys(limits)) if (!seen.has(l)) rows.push([l, '-', str(limits[l]), 'sin contador de uso']);
  s.push({ title: 'Presupuesto (usado / limite)', blocks: [rows.length
    ? { t: 'table', head: ['Recurso', 'Usado', 'Limite', 'Uso'], rows }
    : { t: 'p', text: `Presupuesto: ${NA}.` },
    { t: 'p', text: arr(budget.exhausted).length ? 'Agotado: ' + arr(budget.exhausted).map(str).join(', ') : 'Ningun limite agotado.' }, ...budgetExtraBlocks(budget)] });

  s.push({ title: 'Discovery', blocks: [{ t: 'kv', rows: [['Estado', str(disc.status)], ['Tablas (' + arr(disc.tables).length + ')', arr(disc.tables).map(str).join(', ') || '-'], ['Relaciones (' + arr(disc.relations).length + ')', arr(disc.relations).map(str).join(', ') || '-']] }] });

  const proposals = arr(coma.outOfScopeProposals), blind = obj(coma.blind);
  s.push({ title: 'COMA', blocks: [{ t: 'kv', rows: [['Estado', str(coma.status)], ['Candidatos', str(coma.candidates)], ['Propuestas fuera de alcance', String(proposals.length)], ['Proveedores', arr(coma.providerStates).map(p => `${str(p.providerId)}: ${str(p.status)}`).join('; ') || '-']] },
    ...(coma.blind === undefined ? [] : [{ t: 'p', text: `Busqueda ciega: ${of(blind.pairs, blind.tablePairs)} pares de tablas comparados${blind.capped === true ? `; la busqueda esta limitada por el tope de ${str(blind.cap)} pares y NO es exhaustiva` : '; el tope no limito la busqueda'}${blind.order ? `; orden: ${str(blind.order)}` : ''}.` } as Block]),
    ...(proposals.length > COMA_TOP_N ? [{ t: 'p', text: `Se listan las ${COMA_TOP_N} de mayor puntaje crudo de ${proposals.length} propuestas fuera de alcance; el resto esta en engine-run.json (phases.coma.outOfScopeProposals).` } as Block] : []),
    ...(proposals.length ? [{ t: 'table', head: ['Desde', 'Hacia', 'Puntaje crudo', 'Motivo', 'Verificacion', 'Revision'], rows: (proposals.length > COMA_TOP_N ? [...proposals].sort((a, b) => (Number(b.rawScore) || 0) - (Number(a.rawScore) || 0)).slice(0, COMA_TOP_N) : proposals).map(p => [`${str(p.from?.table)}.${str(p.from?.column)}`, `${str(p.to?.table)}.${str(p.to?.column)}`, str(p.rawScore), str(p.reason), str(p.verificationStatus), str(p.reviewState)]) } as Block] : [])] });

  const pool = obj(obj(run.postComa).sourcePool), sampled = arr(obj(run.postComa).proposals).filter(p => obj(obj(p.coverageProbe).sampling).source === 'GLOBAL_DISTINCT_F4'), executedP = arr(obj(run.postComa).proposals).filter(p => obj(p.coverageProbe).status === 'EXECUTED');
  const poolBlocks: Block[] = sampled.length || Object.keys(pool).length ? [{ t: 'p', text: `muestra ampliada con claves distintas globales en ${new Set(sampled.map(p => `${str(obj(p.to).table)}.${str(obj(p.to).column)}`)).size} columnas (${pool.queries === undefined ? NA : `${str(pool.queries)} SQL`}); ${of(sampled.length, executedP.length)} sondas ejecutadas usan esa muestra${pool.hits !== undefined || pool.failures !== undefined ? `; aciertos ${str(pool.hits)}, fallos ${str(pool.failures)}` : ''}.` }] : [];
  s.push({ title: 'Post-COMA', blocks: [...postComaBlocks(run.postComa), ...poolBlocks, ...notExecutedBlocks(run)] });
  const cands = candidateBlocks(run.postComa);
  if (cands.length) s.push({ title: 'Candidatas descubiertas (requieren revision)', blocks: cands });
  const dq = dataQualityBlocks(run.postComa);
  if (dq.length) s.push({ title: 'Hallazgos de calidad de datos', blocks: dq });

  const calls = arr(expl.calls), actions = arr(expl.actions);
  s.push({ title: `Decisiones del modelo (${calls.length} llamadas)`, blocks: [calls.length ? { t: 'table', head: ['Etapa', 'Estado', 'Decision', 'Accion', 'Razon', 'Recibo'], rows: calls.map(c => {
      const r = obj(c.receipt);
      return [str(c.stage), str(c.status), str(c.decisionStatus), str(c.selected ?? c.error?.code), str(c.reason), r.receiptId ? `${r.receiptId} (${str(r.model)}, ${str(r.totalTokens)} tokens)` : 'sin recibo'];
    }) } : { t: 'p', text: 'No hubo llamadas al modelo en este run.' },
    ...(expl.plannerError ? [{ t: 'p', text: 'Error del planificador: ' + str(expl.plannerError) } as Block] : [])] });
  const telemetry = telemetryBlocks(calls);
  if (telemetry.length) s.push({ title: 'Telemetria del modelo por llamada', blocks: telemetry });
  const invalid = calls.filter(c => c.decisionStatus === 'INVALID_RESPONSE');
  if (invalid.length) {
    const log = arr(opts.decisionLog);
    s.push({ title: `Respuestas invalidas del modelo (${invalid.length} de ${calls.length} llamadas)`, blocks: [{ t: 'table', head: ['Etapa', 'Error', 'Registro', 'Largo', 'Inicio de la respuesta'], rows: invalid.map(c => {
      const i = log.findIndex(l => l && l.stage === c.stage && l.promptHash === c.promptHash), text = i >= 0 && typeof log[i].responseText === 'string' ? log[i].responseText as string : undefined;
      return [str(c.stage), str(c.error?.code), i >= 0 ? `${DECISION_LOG}, linea ${i + 1}` : `${DECISION_LOG}: sin entrada para esta llamada`, text === undefined ? '-' : `${text.length} caracteres`, text === undefined ? '-' : (text.length > 200 ? text.slice(0, 200) + ' [...]' : text)];
    }) }] });
  }
  const typed = actions.some(a => obj(obj(a.observation).summary).kind !== undefined);
  s.push({ title: `Acciones ejecutadas (${actions.length})`, blocks: [actions.length ? (typed
    ? { t: 'table', head: ['Paso', 'Accion', 'Tipo', 'Ejecucion', 'Razon', 'Filas', 'Resumen'], rows: actions.map(a => [str(a.step), str(a.action), str(obj(obj(a.observation).summary).kind ?? 'KEYED_READ'), str(a.execution), str(a.reason), str(a.observation?.rows), actionSummary(a)]) }
    : { t: 'table', head: ['Paso', 'Accion', 'Ejecucion', 'Razon', 'Filas'], rows: actions.map(a => [str(a.step), str(a.action), str(a.execution), str(a.reason), str(a.observation?.rows)]) }) : { t: 'p', text: 'Sin acciones.' }, ...alternativesBlocks(run)] });

  const readErrors = arr(expl.explorationErrors);
  if (readErrors.length) s.push({ title: `Lecturas fallidas (${readErrors.length})`, blocks: [{ t: 'p', text: `lecturas fallidas: ${readErrors.length}. El run queda DEGRADED (EXPLORATION_READ_FAILED); una lectura fallida no es evidencia a favor ni en contra.` }, { t: 'table', head: ['Paso', 'Accion', 'Codigo', 'Mensaje'], rows: readErrors.map(e => [str(obj(e).step), str(obj(e).action), str(obj(e).code), str(obj(e).message)]) }] });
  const reads = Object.entries(obj(expl.reads));
  s.push({ title: `Lecturas (${reads.length})`, blocks: [reads.length ? { t: 'table', head: ['Lectura', 'Fuente', 'Columnas', 'Filas'], rows: reads.map(([k, v]) => [k, str(v?.source), arr(v?.columns).map(str).join(', ') || '-', str(v?.rows)]) } : { t: 'p', text: 'Sin lecturas.' }] });

  const sel = arr(probes.selected), skipped = arr(probes.skipped);
  const mode = obj(run.probeSelection).mode;
  s.push({ title: 'Sondas y veredictos', blocks: [{ t: 'kv', rows: [['Modo de seleccion', mode === undefined ? NA : str(mode)], ['Ranking de sondas por modelo', rankingCell(obj(run.probeSelection)) ?? (obj(run.probeSelection).modelRanking === 'NOT_USED' ? 'no usado en esta corrida (presupuesto)' : obj(run.probeSelection).modelRanking === 'USED' ? 'usado' : obj(run.probeSelection).modelRanking === undefined ? NA : str(obj(run.probeSelection).modelRanking))], ['Sondas seleccionadas', `${sel.length}: ${sel.map(str).join(', ') || '-'}`], ['Omitidas', `${skipped.length}${skipped.length ? ': ' + skipped.map(str).join('; ') : ''}`], ['Error de sondas', str(probes.error)]] },
    arr(run.decisions).length ? { t: 'table', head: ['Relacion', 'Veredicto', 'Razones'], rows: arr(run.decisions).map(d => [str(d.relationId), str(d.verdict), arr(d.reasonCodes).map(str).join(', ') || '-']) } : { t: 'p', text: 'Sin veredictos.' }, ...incompletenessBlocks(artifacts)] });

  s.push({ title: 'Cobertura y riesgo', blocks: coverageBlocks(run) });
  s.push({ title: 'Memoria y revision humana', blocks: memoryBlocks(run) });
  s.push({ title: 'Metricas por etapa', blocks: [{ t: 'table', head: ['Etapa', 'Metrica', 'Valor'], rows: stageMetrics(run, artifacts).map(m => [...m]) }] });
  const fe = fullEvidenceBlocks(artifacts);
  if (fe.length) s.push({ title: 'Evidencia completa (medicion global)', blocks: fe });
  const mrb = modelReviewBlocks(run, opts.modelReviewOverlay);
  if (mrb.length) s.push({ title: 'Revision por modelo con pase adversarial', blocks: mrb });
  s.push({ title: 'Por que cada veredicto', blocks: whyBlocks(run, artifacts) });
  const explained = explanationBlocks(artifacts);
  if (explained.length) s.push({ title: 'Explicaciones del modelo (no decisorias)', blocks: explained });

  const sm = obj(critic.summary);
  const assist = criticAssistBlocks(run);
  s.push({ title: 'Critica', blocks: [{ t: 'kv', rows: [['Estado', str(critic.status)], ['Elegibles', str(critic.eligible)], ...Object.keys(sm).map((k): [string, string] => [k, typeof critic.eligible === 'number' ? `${sm[k]} de ${critic.eligible} elegibles` : str(sm[k])])] }] });
  if (assist.length) s.push({ title: 'Critico asistido por el modelo', blocks: assist });

  s.push({ title: 'Artifacts', blocks: artifactBlocks(run, artifacts) });
  return s;
}

const mdCell = (v: string) => v.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
export function renderAgentRunMarkdown(run: any, artifacts?: unknown, opts: ReportOpts = {}): string {
  const out = [`# Reporte del run del agente: ${str(run.runId)}`, '', `**${str(run.executionMode)}** | origen de datos: **${str(run.dataOrigin)}**`, '',
    `- Universo: ${str(run.universeId)} (${str(run.manifestId)})`, `- runId: ${str(run.runId)}`, `- executionMode: ${str(run.executionMode)}`, `- dataOrigin: ${str(run.dataOrigin)}`, `- UTC: ${str(run.utc)}`, ''];
  out.push(...sectionsMd(buildAgentRunSections(run, artifacts, opts)));
  return scrub(out.join('\n'));
}
function sectionsMd(sections: Section[]): string[] {
  const out: string[] = [];
  for (const sec of sections) {
    out.push(`## ${sec.title}`, '');
    for (const b of sec.blocks) {
      if (b.t === 'p') out.push(b.text, '');
      else if (b.t === 'list') out.push(...b.items.map(i => '- ' + i), '');
      else if (b.t === 'kv') out.push(...b.rows.map(([k, v]) => `- **${k}**: ${v}`), '');
      else out.push('| ' + b.head.join(' | ') + ' |', '|' + b.head.map(() => '---').join('|') + '|', ...b.rows.map(r => '| ' + r.map(mdCell).join(' | ') + ' |'), '');
    }
  }
  return out;
}

export function renderAgentRunHtml(run: any, artifacts?: unknown, opts: ReportOpts = {}): string {
  const e = escapeHtml, mode = str(run.executionMode);
  const body = buildAgentRunSections(run, artifacts, opts).map(sec => '<section><h2>' + e(sec.title) + '</h2>' + sec.blocks.map(b =>
    b.t === 'p' ? '<p>' + e(b.text) + '</p>' : b.t === 'list' ? '<ul>' + b.items.map(i => '<li>' + e(i) + '</li>').join('') + '</ul>'
    : b.t === 'kv' ? '<dl>' + b.rows.map(([k, v]) => '<dt>' + e(k) + '</dt><dd>' + e(v) + '</dd>').join('') + '</dl>'
    : '<table><thead><tr>' + b.head.map(h => '<th>' + e(h) + '</th>').join('') + '</tr></thead><tbody>' + b.rows.map(r => '<tr>' + r.map(c => '<td>' + e(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>').join('') + '</section>').join('');
  const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Reporte del run ${e(str(run.runId))}</title><style>
body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:1000px;padding:0 1rem;color:#1b1f23}
.badge{display:inline-block;padding:.3rem .8rem;border-radius:4px;color:#fff;font-weight:700;font-size:1.1rem;margin-right:.5rem}
.LIVE{background:#b42318}.REPLAY{background:#175cd3}.SYNTHETIC{background:#6941c6}.OTHER{background:#475467}
table{border-collapse:collapse;width:100%;margin:.5rem 0}th,td{border:1px solid #d0d5dd;padding:.3rem .5rem;text-align:left;vertical-align:top;font-size:.9rem}th{background:#f2f4f7}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.2rem 1rem}dt{font-weight:600}dd{margin:0}section{margin-top:1.5rem}
</style></head><body><h1>Reporte del run: ${e(str(run.runId))}</h1>
<p><span class="badge ${['LIVE', 'REPLAY', 'SYNTHETIC'].includes(mode) ? mode : 'OTHER'}">${e(mode)}</span><span class="badge OTHER">origen de datos: ${e(str(run.dataOrigin))}</span></p>
<dl><dt>Universo</dt><dd>${e(str(run.universeId))} (${e(str(run.manifestId))})</dd><dt>runId</dt><dd>${e(str(run.runId))}</dd><dt>executionMode</dt><dd>${e(mode)}</dd><dt>dataOrigin</dt><dd>${e(str(run.dataOrigin))}</dd><dt>UTC</dt><dd>${e(str(run.utc))}</dd></dl>${body}</body></html>`;
  return scrub(html);
}

export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const budgetRow = (run: any, k: string): string => { const u = obj(obj(run.budget).used)[k], l = obj(obj(run.budget).limits); const lk = ['max' + k[0].toUpperCase() + k.slice(1) + 'PerRun', 'max' + k[0].toUpperCase() + k.slice(1)].find(x => x in l); return u === undefined ? '-' : lk && typeof l[lk] === 'number' ? of(u, l[lk]) : `${u} (sin limite declarado)`; };
const verdictCounts = (run: any): string => { const d = arr(run.decisions), m = new Map<string, number>(); for (const x of d) m.set(str(x.verdict), (m.get(str(x.verdict)) ?? 0) + 1); return d.length ? [...m].map(([k, v]) => `${k}: ${of(v, d.length)}`).join('; ') : 'sin veredictos'; };

export function buildAgentRunComparison(rawA: any, rawB: any, rawArts?: { a?: unknown; b?: unknown }): Section[] {
  const a = normalizeRunOrder(rawA), b = normalizeRunOrder(rawB), arts = rawArts && { a: normalizeArtifactsOrder(rawArts.a), b: normalizeArtifactsOrder(rawArts.b) };
  const s: Section[] = [], same = a.universeId === b.universeId;
  const head = (r: any) => `${str(r.runId)} (${str(r.executionMode)})`;
  const pcN = (r: any) => { const p = obj(r.postComa), n = arr(p.proposals).length; return r.postComa === undefined ? NA : of(arr(p.proposals).filter(x => obj(x.coverageProbe).status === 'EXECUTED').length, n) + ' sondas ejecutadas'; };
  s.push({ title: 'Comparacion de runs', blocks: [{ t: 'p', text: same ? `Mismo universo: ${str(a.universeId)}.` : `Universos distintos (${str(a.universeId)} frente a ${str(b.universeId)}): las diferencias de tokens o llamadas no se pueden atribuir a un cambio de codigo.` },
    { t: 'table', head: ['Metrica', head(a), head(b)], rows: [
      ['Origen de datos', str(a.dataOrigin), str(b.dataOrigin)], ['Estado', str(a.status), str(b.status)],
      ['Consultas', budgetRow(a, 'queries'), budgetRow(b, 'queries')], ['Tokens', budgetRow(a, 'tokens'), budgetRow(b, 'tokens')], ['Pasos', budgetRow(a, 'steps'), budgetRow(b, 'steps')],
      ['Llamadas al modelo', String(arr(obj(obj(a.phases).exploration).calls).length), String(arr(obj(obj(b.phases).exploration).calls).length)],
      ['Veredictos', verdictCounts(a), verdictCounts(b)], ['Post-COMA', pcN(a), pcN(b)],
      ['Limites agotados', arr(obj(a.budget).exhausted).map(str).join(', ') || 'ninguno', arr(obj(b.budget).exhausted).map(str).join(', ') || 'ninguno']] }] });
  const ma = stageMetrics(a, arts?.a), mb = stageMetrics(b, arts?.b);
  s.push({ title: 'Metricas por etapa', blocks: [{ t: 'table', head: ['Etapa', 'Metrica', str(a.runId), str(b.runId)], rows: ma.map((m, i) => [m[0], m[1], m[2], mb[i][2]]) }] });
  const ea = efficiencyRows(a), eb = efficiencyRows(b);
  s.push({ title: 'Eficiencia', blocks: [{ t: 'table', head: ['Metrica', str(a.runId), str(b.runId)], rows: ea.map((e, i) => [e[0], e[1], eb[i][1]]) }] });
  const da = new Map(arr(a.decisions).map(d => [str(d.relationId), d])), db = new Map(arr(b.decisions).map(d => [str(d.relationId), d]));
  const ids = [...new Set([...da.keys(), ...db.keys()])];
  const cell = (d: any) => d ? `${str(d.verdict)} (${arr(d.reasonCodes).map(str).join(', ') || '-'})` : 'no presente en este run';
  s.push({ title: 'Veredictos por relacion', blocks: [ids.length ? { t: 'table', head: ['Relacion', str(a.runId), str(b.runId), 'Igual'], rows: ids.map(id => [id, cell(da.get(id)), cell(db.get(id)), da.has(id) && db.has(id) ? (da.get(id).verdict === db.get(id).verdict ? 'si' : 'no') : 'no comparable']) } : { t: 'p', text: 'Sin veredictos en ninguno de los dos runs.' }] });
  return s;
}
export function renderAgentRunComparisonMarkdown(a: any, b: any, arts?: { a?: unknown; b?: unknown }): string {
  return scrub([`# Comparacion de runs: ${str(a.runId)} frente a ${str(b.runId)}`, '', ...sectionsMd(buildAgentRunComparison(a, b, arts))].join('\n'));
}
export function readEngineRun(runsDir: string, runId: string): any {
  if (!RUN_ID.test(runId)) throw new SafeError('AGENT_REPORT_RUN_ID_INVALID');
  const file = path.join(runsDir, runId, 'engine-run.json');
  if (!fs.existsSync(file)) throw new SafeError('AGENT_REPORT_ENGINE_RUN_NOT_FOUND');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new SafeError('AGENT_REPORT_ENGINE_RUN_INVALID_JSON'); }
}
export function writeAgentRunComparison(idA: string, idB: string, runsDir = path.join(ROOT, '.concordia', 'agent-runs')): { dir: string; files: string[] } {
  const a = readEngineRun(runsDir, idA), b = readEngineRun(runsDir, idB);
  const art = (id: string, r: any): unknown => { try { return typeof r.artifactsFile === 'string' ? JSON.parse(fs.readFileSync(path.join(runsDir, id, path.basename(r.artifactsFile)), 'utf8')) : undefined; } catch { return undefined; } };
  const name = `compare-${idA}-vs-${idB}.md`;
  fs.writeFileSync(path.join(runsDir, name), renderAgentRunComparisonMarkdown(a, b, { a: art(idA, a), b: art(idB, b) }));
  return { dir: runsDir, files: [name] };
}

export function writeAgentRunReport(runId: string, runsDir = path.join(ROOT, '.concordia', 'agent-runs')): { dir: string; files: string[] } {
  if (!RUN_ID.test(runId)) throw new SafeError('AGENT_REPORT_RUN_ID_INVALID');
  const dir = path.join(runsDir, runId), file = path.join(dir, 'engine-run.json');
  if (!fs.existsSync(file)) throw new SafeError('AGENT_REPORT_ENGINE_RUN_NOT_FOUND');
  let run: any;
  try { run = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new SafeError('AGENT_REPORT_ENGINE_RUN_INVALID_JSON'); }
  let artifacts: unknown;
  if (typeof run.artifactsFile === 'string') {
    try { artifacts = JSON.parse(fs.readFileSync(path.join(dir, path.basename(run.artifactsFile)), 'utf8')); } catch { artifacts = undefined; }
  }
  let decisionLog: any[] | undefined;
  try { decisionLog = fs.readFileSync(path.join(dir, DECISION_LOG), 'utf8').split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l)); } catch { decisionLog = undefined; }
  let modelReviewOverlay: unknown; try { modelReviewOverlay = JSON.parse(fs.readFileSync(path.join(dir, 'model-review-overlay.json'), 'utf8')); } catch { modelReviewOverlay = undefined; }
  const opts: ReportOpts = { decisionLog, negativeControl: loadNegativeControlSummary(dir, run), modelReviewOverlay };
  fs.writeFileSync(path.join(dir, 'report.md'), renderAgentRunMarkdown(run, artifacts, opts));
  fs.writeFileSync(path.join(dir, 'report.html'), renderAgentRunHtml(run, artifacts, opts));
  return { dir, files: ['report.md', 'report.html'] };
}
