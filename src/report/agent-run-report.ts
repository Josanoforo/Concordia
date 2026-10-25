import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SafeError, sanitize } from '../runtime.ts';
import { escapeHtml } from './index.ts';
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
const scrub = (text: string): string => sanitize(text)
  .replace(/[A-Za-z]:[\\/][^\s"'<>|,;)]*/g, '[ruta local]')
  .replace(/(^|[\s"'(])\/(?:home|Users|root|mnt|tmp|var|opt)\/[^\s"'<>|,;)]*/g, '$1[ruta local]');

const ref = (c: unknown): string => { const o = obj(c); return o.table === undefined ? '-' : `${str(o.db)}.${str(o.table)}.${str(o.column)}`; };
const of = (n: unknown, d: unknown): string => typeof n === 'number' && typeof d === 'number' && d > 0 ? `${n} de ${d}` : typeof n === 'number' ? `${n} (sin denominador)` : '-';

function coverageCell(cp: Record<string, any>): string {
  const r = obj(cp.result);
  if (cp.status === 'EXECUTED') return `${of(r.targetMatches, r.probedValues)} valores sondeados (${of(r.probedValues, r.sampledSourceValues)} muestreados)`;
  return cp.reason ? `${str(cp.status)}: ${str(cp.reason)}` : str(cp.status);
}
function postComaBlocks(pc: unknown): Block[] {
  if (pc === undefined) return [{ t: 'p', text: `Post-COMA: ${NA}.` }];
  const p = obj(pc), proposals = arr(p.proposals), pol = obj(p.policy);
  if (!proposals.length && p.policy === undefined && p.counts === undefined) return [{ t: 'kv', rows: Object.entries(p).map(([k, v]): [string, string] => [k, str(v)]) }];
  const by = (st: string) => proposals.filter(x => obj(x.coverageProbe).status === st).length, c = obj(p.counts);
  const n = proposals.length, executed = c.executed ?? by('EXECUTED');
  const out: Block[] = [{ t: 'kv', rows: [['Estado', str(p.status)], ['Propuestas', String(n)], ['Sondas ejecutadas', of(executed, n)], ['No ejecutables', of(c.notExecutable ?? by('NOT_EXECUTABLE'), n)],
    ['Politica', `maximo ${str(pol.maxProbes)} sondas; costo ${str(pol.costPerProbe)} por sonda; orden: ${str(pol.ranking)}; igualdad: ${str(pol.equality)}`]] }];
  if (n) out.push({ t: 'table', head: ['Propuesta', 'Desde', 'Hacia', 'Puntaje crudo', 'Cobertura de la sonda', 'Revision', 'Veredicto'], rows: proposals.map(x => [str(x.proposalId), ref(x.from), ref(x.to), str(x.rawScore), coverageCell(obj(x.coverageProbe)), str(x.reviewState), str(x.verificationStatus)]) });
  if (arr(p.limitations).length) out.push({ t: 'list', items: arr(p.limitations).map(str) });
  return out;
}
// Eficiencia: datos destacados con denominador; el costo solo si el run o los recibos lo traen.
export function efficiencyRows(run: any): [string, string][] {
  const calls = arr(obj(obj(run.phases).exploration).calls), rc = calls.map(c => obj(c.receipt)).filter(r => r.receiptId), n = calls.length, dec = arr(run.decisions).length;
  const tokens = rc.reduce((t: number, r: any) => t + (typeof r.totalTokens === 'number' ? r.totalTokens : 0), 0);
  const lim = obj(obj(run.budget).limits), used = obj(obj(run.budget).used), q = used.queries, ql = lim.maxQueriesPerRun;
  const valid = calls.filter(c => c.decisionStatus === 'VALID').length;
  const costOf = (o: Record<string, any>) => Object.entries(o).filter(([k, v]) => /cost/i.test(k) && typeof v === 'number');
  const costs = [...costOf(obj(obj(run.budget).used)), ...costOf(obj(run)), ...rc.flatMap((r: any) => costOf(r))];
  return [
    ['Tokens del modelo', typeof lim.maxTokensPerRun === 'number' ? of(tokens, lim.maxTokensPerRun) + ' del tope' : n ? `${tokens} (sin tope declarado)` : '0'],
    ['Tokens por decision del modelo', n ? `${Math.round(tokens / n)} (${tokens} tokens en ${n} decisiones; ${valid} validas)` : 'sin decisiones del modelo'],
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
function memoryBlocks(run: any): Block[] {
  if (run.memory === undefined) return [{ t: 'p', text: `Memoria: ${NA}.` }];
  const m = obj(run.memory), claims = arr(m.claims), conflicts = arr(m.conflicts), queue = arr(m.reviewQueue), led = obj(m.ledger);
  const live = claims.filter(c => !c.superseded).length, cs = (st: string) => conflicts.filter(c => c.status === st).length;
  const out: Block[] = [{ t: 'kv', rows: [['Estado', str(m.status)], ['Alcance', str(m.scope)], ['Claims vigentes', of(live, claims.length)], ['Conflictos en cola', of(cs('queued'), conflicts.length)], ['Conflictos auto-resueltos', of(cs('auto_resolved'), conflicts.length)], ['Conflictos resueltos por humano', of(cs('human_resolved'), conflicts.length)],
    ['Bitacora', led.entries === undefined ? NA : `${str(led.entries)} entradas${led.appendOnly ? ' (solo anexo)' : ''}`], ...(m.reason ? [['Motivo', str(m.reason)] as [string, string]] : []), ...(m.error ? [['Error', str(m.error)] as [string, string]] : [])] }];
  out.push({ t: 'p', text: queue.length ? `Cola de revision humana: ${queue.length} de ${conflicts.length} conflictos esperan decision.` : 'Cola de revision humana: vacia.' });
  if (queue.length) out.push({ t: 'table', head: ['Conflicto', 'Entidad', 'Atributo', 'Version', 'Claims', 'Estrategia'], rows: queue.map(q => [str(q.conflictId), str(q.entity), str(q.attribute), str(q.version), arr(q.claimIds).map(str).join(', ') || '-', str(q.strategy)]) });
  if (conflicts.length) out.push({ t: 'table', head: ['Conflicto', 'Entidad', 'Atributo', 'Estado', 'Version', 'Ganador'], rows: conflicts.map(c => [str(c.id), str(c.entity), str(c.attribute), str(c.status), str(c.version), str(c.winner)]) });
  if (claims.length) out.push({ t: 'table', head: ['Claim', 'Relacion', 'Atributo', 'Valor', 'Regla', 'Fuente', 'Primer run', 'Runs', 'Vigente'], rows: claims.map(c => [str(c.id), str(c.relationId), str(c.attribute), str(c.value), str(c.rule), `${str(c.source)} ${str(c.sourceVersion)}`.trim(), str(c.firstRunId), String(arr(c.runIds).length), c.superseded ? `no (reemplazado por ${str(c.supersededBy)})` : 'si']) });
  for (const k of ['reuse', 'revalidation']) if (m[k] !== undefined || run[k] !== undefined) out.push({ t: 'kv', rows: Object.entries(obj(m[k] ?? run[k])).map(([a, b]): [string, string] => [`${k}.${a}`, str(b)]) });
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
  return '-';
}

const DECISION_LOG = 'adaptive-decisions.jsonl';
export type ReportOpts = { decisionLog?: any[] };
export function buildAgentRunSections(run: any, artifacts?: unknown, opts: ReportOpts = {}): Section[] {
  const s: Section[] = [];
  const phases = obj(run.phases), disc = obj(phases.discovery), coma = obj(phases.coma), expl = obj(phases.exploration), probes = obj(phases.probes), critic = obj(phases.critic);
  const budget = obj(run.budget), limits = obj(budget.limits), used = obj(budget.used);

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
    { t: 'p', text: arr(budget.exhausted).length ? 'Agotado: ' + arr(budget.exhausted).map(str).join(', ') : 'Ningun limite agotado.' }] });

  s.push({ title: 'Discovery', blocks: [{ t: 'kv', rows: [['Estado', str(disc.status)], ['Tablas (' + arr(disc.tables).length + ')', arr(disc.tables).map(str).join(', ') || '-'], ['Relaciones (' + arr(disc.relations).length + ')', arr(disc.relations).map(str).join(', ') || '-']] }] });

  const proposals = arr(coma.outOfScopeProposals);
  s.push({ title: 'COMA', blocks: [{ t: 'kv', rows: [['Estado', str(coma.status)], ['Candidatos', str(coma.candidates)], ['Propuestas fuera de alcance', String(proposals.length)], ['Proveedores', arr(coma.providerStates).map(p => `${str(p.providerId)}: ${str(p.status)}`).join('; ') || '-']] },
    ...(proposals.length ? [{ t: 'table', head: ['Desde', 'Hacia', 'Puntaje crudo', 'Motivo', 'Verificacion', 'Revision'], rows: proposals.map(p => [`${str(p.from?.table)}.${str(p.from?.column)}`, `${str(p.to?.table)}.${str(p.to?.column)}`, str(p.rawScore), str(p.reason), str(p.verificationStatus), str(p.reviewState)]) } as Block] : [])] });

  s.push({ title: 'Post-COMA', blocks: postComaBlocks(run.postComa) });

  const calls = arr(expl.calls), actions = arr(expl.actions);
  s.push({ title: `Decisiones del modelo (${calls.length} llamadas)`, blocks: [calls.length ? { t: 'table', head: ['Etapa', 'Estado', 'Decision', 'Accion', 'Razon', 'Recibo'], rows: calls.map(c => {
      const r = obj(c.receipt);
      return [str(c.stage), str(c.status), str(c.decisionStatus), str(c.selected ?? c.error?.code), str(c.reason), r.receiptId ? `${r.receiptId} (${str(r.model)}, ${str(r.totalTokens)} tokens)` : 'sin recibo'];
    }) } : { t: 'p', text: 'No hubo llamadas al modelo en este run.' },
    ...(expl.plannerError ? [{ t: 'p', text: 'Error del planificador: ' + str(expl.plannerError) } as Block] : [])] });
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

  const reads = Object.entries(obj(expl.reads));
  s.push({ title: `Lecturas (${reads.length})`, blocks: [reads.length ? { t: 'table', head: ['Lectura', 'Fuente', 'Columnas', 'Filas'], rows: reads.map(([k, v]) => [k, str(v?.source), arr(v?.columns).map(str).join(', ') || '-', str(v?.rows)]) } : { t: 'p', text: 'Sin lecturas.' }] });

  const sel = arr(probes.selected), skipped = arr(probes.skipped);
  const mode = obj(run.probeSelection).mode;
  s.push({ title: 'Sondas y veredictos', blocks: [{ t: 'kv', rows: [['Modo de seleccion', mode === undefined ? NA : str(mode)], ['Ranking de sondas por modelo', obj(run.probeSelection).modelRanking === 'NOT_USED' ? 'no usado en esta corrida (presupuesto)' : obj(run.probeSelection).modelRanking === 'USED' ? 'usado' : NA], ['Sondas seleccionadas', `${sel.length}: ${sel.map(str).join(', ') || '-'}`], ['Omitidas', `${skipped.length}${skipped.length ? ': ' + skipped.map(str).join('; ') : ''}`], ['Error de sondas', str(probes.error)]] },
    arr(run.decisions).length ? { t: 'table', head: ['Relacion', 'Veredicto', 'Razones'], rows: arr(run.decisions).map(d => [str(d.relationId), str(d.verdict), arr(d.reasonCodes).map(str).join(', ') || '-']) } : { t: 'p', text: 'Sin veredictos.' }, ...incompletenessBlocks(artifacts)] });

  s.push({ title: 'Memoria y revision humana', blocks: memoryBlocks(run) });
  s.push({ title: 'Metricas por etapa', blocks: [{ t: 'table', head: ['Etapa', 'Metrica', 'Valor'], rows: stageMetrics(run, artifacts).map(m => [...m]) }] });
  s.push({ title: 'Por que cada veredicto', blocks: whyBlocks(run, artifacts) });

  const sm = obj(critic.summary);
  s.push({ title: 'Critica', blocks: [{ t: 'kv', rows: [['Estado', str(critic.status)], ['Elegibles', str(critic.eligible)], ...Object.keys(sm).map((k): [string, string] => [k, typeof critic.eligible === 'number' ? `${sm[k]} de ${critic.eligible} elegibles` : str(sm[k])])] }] });

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

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const budgetRow = (run: any, k: string): string => { const u = obj(obj(run.budget).used)[k], l = obj(obj(run.budget).limits); const lk = ['max' + k[0].toUpperCase() + k.slice(1) + 'PerRun', 'max' + k[0].toUpperCase() + k.slice(1)].find(x => x in l); return u === undefined ? '-' : lk && typeof l[lk] === 'number' ? of(u, l[lk]) : `${u} (sin limite declarado)`; };
const verdictCounts = (run: any): string => { const d = arr(run.decisions), m = new Map<string, number>(); for (const x of d) m.set(str(x.verdict), (m.get(str(x.verdict)) ?? 0) + 1); return d.length ? [...m].map(([k, v]) => `${k}: ${of(v, d.length)}`).join('; ') : 'sin veredictos'; };

export function buildAgentRunComparison(a: any, b: any, arts?: { a?: unknown; b?: unknown }): Section[] {
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
function readEngineRun(runsDir: string, runId: string): any {
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
  const opts: ReportOpts = { decisionLog };
  fs.writeFileSync(path.join(dir, 'report.md'), renderAgentRunMarkdown(run, artifacts, opts));
  fs.writeFileSync(path.join(dir, 'report.html'), renderAgentRunHtml(run, artifacts, opts));
  return { dir, files: ['report.md', 'report.html'] };
}
