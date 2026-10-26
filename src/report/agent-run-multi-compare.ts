import fs from 'node:fs';
import path from 'node:path';
import { ROOT, SafeError } from '../runtime.ts';
import { scrub } from './index.ts';
import { normalizeArtifactsOrder, normalizeRunOrder } from './order.ts';
import { RUN_ID, budgetRow, claimsByOrigin, modelParticipationOf, readEngineRun } from './agent-run-report.ts';
import { loadTpcdsGold, scoreTpcdsCandidates, type CandidateEdge, type TpcdsGold } from '../eval/tpcds-gold.ts';

/**
 * Comparador de N corridas desde sus engine-run.json (hermano de agent-compare, que compara dos).
 * La seccion "evaluacion fuera del runtime" es la unica que lee el gold; vive en esta herramienta de reporte y el agente (src/agent) nunca lo importa.
 */
const arr = (v: unknown): any[] => Array.isArray(v) ? v : [];
const obj = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {};
const str = (v: unknown): string => v === undefined || v === null || v === '' ? '-' : typeof v === 'string' ? v : JSON.stringify(v);
const of = (n: number, d: number): string => d > 0 ? `${n} de ${d}` : `${n} (sin denominador)`;
const pct = (x: number | null): string => x === null ? 'no calculable' : `${(x * 100).toFixed(1)}%`;
const EXEC = ['LIVE', 'REPLAY', 'LOCAL'], ORIGIN = ['SYNTHETIC', 'PUBLIC', 'USER', 'UNKNOWN'];

export interface RunInput { run: any; artifacts?: unknown }
const probesOf = (artifacts: unknown): any[] => arr(obj(artifacts).probes);
const edgeOf = (p: any): CandidateEdge | undefined => p?.from?.table && p?.to?.table ? { from: { table: String(p.from.table), column: String(p.from.column) }, to: { table: String(p.to.table), column: String(p.to.column) } } : undefined;

/** Pares aceptados (decisiones SOSTENIDA con sus extremos tomados de las sondas guardadas). */
function acceptedEdges(input: RunInput): CandidateEdge[] {
  const probes = new Map(probesOf(input.artifacts).map(p => [String(p.relationId), p]));
  return arr(input.run.decisions).filter(d => d.verdict === 'SOSTENIDA').flatMap(d => { const e = edgeOf(probes.get(String(d.relationId))); return e ? [e] : []; });
}
/** Candidatas aceptadas por diagnostico: sonda ejecutada, cobertura HIGH y sin sospecha. Son candidatas, no veredictos. */
function diagnosticAcceptedEdges(run: any): CandidateEdge[] {
  return arr(obj(run.postComa).proposals).filter(x => { const cp = obj(x.coverageProbe), d = obj(cp.diagnostic); return cp.status === 'EXECUTED' && obj(d.coverage).level === 'HIGH' && obj(d.suspect).value === false; }).flatMap(x => { const e = edgeOf(x); return e ? [e] : []; });
}
/** Pares que recibieron una sonda de cobertura post-COMA ejecutada. */
function probedEdges(run: any): CandidateEdge[] {
  return arr(obj(run.postComa).proposals).filter(x => obj(x.coverageProbe).status === 'EXECUTED').flatMap(x => { const e = edgeOf(x); return e ? [e] : []; });
}

function column(input: RunInput): string[] {
  const r = input.run, used = obj(obj(r.budget).used), ds = arr(r.decisions), calls = arr(obj(obj(r.phases).exploration).calls);
  const pc = obj(r.postComa), props = arr(pc.proposals), execPc = props.filter(x => obj(x.coverageProbe).status === 'EXECUTED').length;
  const selected = arr(obj(obj(r.phases).probes).selected).length, accepted = ds.filter(d => d.verdict === 'SOSTENIDA').length;
  const mem = obj(r.memory), claims = arr(mem.claims), reused = ds.filter(d => d.reused).length;
  const { state } = modelParticipationOf(r);
  return [
    EXEC.includes(r.executionMode) ? r.executionMode : 'UNKNOWN', typeof r.dataOrigin === 'string' && ORIGIN.includes(r.dataOrigin) ? r.dataOrigin : typeof r.dataOrigin?.label === 'string' ? r.dataOrigin.label : 'UNKNOWN',
    str(r.status), state, of(calls.filter(c => c.decisionStatus === 'VALID').length, calls.length),
    budgetRow(r, 'tokens'), budgetRow(r, 'queries'),
    String(selected), r.postComa === undefined ? 'no disponible en este run' : of(execPc, props.length),
    of(accepted, ds.length),
    mem.status === undefined ? 'no disponible en este run' : (() => { const o = claimsByOrigin(r); return `${claims.length} claims (nuevos de este run ${of(o.fresh, o.total)}; previos ${of(o.previous, o.total)}${o.unknown ? `; sin origen ${o.unknown}` : ''}; memoria ${str(mem.status)})`; })(), of(reused, ds.length),
  ];
}
const ROWS = ['Modo de ejecucion', 'Origen de datos', 'Estado', 'Participacion del modelo', 'Llamadas con decision valida', 'Tokens (usados / tope)', 'Consultas (usadas / tope)',
  'Sondas de relacion seleccionadas', 'Sondas de cobertura post-COMA ejecutadas', 'Relaciones aceptadas (SOSTENIDA / decisiones)', 'Claims en memoria tras el run', 'Decisiones reusadas de memoria'];

export function renderAgentRunsComparisonMarkdown(inputs: RunInput[], opts: { gold?: TpcdsGold } = {}): string {
  if (inputs.length < 2) throw new SafeError('AGENT_COMPARE_NEEDS_TWO_RUNS');
  inputs = inputs.map(i => ({ run: normalizeRunOrder(i.run), artifacts: normalizeArtifactsOrder(i.artifacts) }));
  const cols = inputs.map(column), ids = inputs.map(i => String(i.run.runId ?? '-'));
  const table = (head: string[], rows: string[][]) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${r.map(c => c.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')).join(' | ')} |`)].join('\n');
  const out = [`# Comparacion de ${inputs.length} corridas`, '', `Universos: ${[...new Set(inputs.map(i => str(i.run.universeId)))].join(', ')}.`, '',
    table(['Metrica', ...ids], ROWS.map((name, i) => [name, ...cols.map(c => c[i]!)]))];
  const tpcds = inputs.filter(i => i.run.universeId === 'TPCDS');
  if (tpcds.length) {
    const gold = opts.gold ?? loadTpcdsGold();
    out.push('', '## Evaluacion fuera del runtime', '', 'Precision y recall contra el gold de TPC-DS. El gold se lee solo en esta herramienta de reporte; el agente no lo ve ni lo importa. Direccion y denominadores: candidatas unicas de la corrida frente a las aristas del gold; una arista invertida se reporta aparte y no cuenta como acierto.', '');
    const sets: [string, (i: RunInput) => CandidateEdge[]][] = [['aceptadas por diagnostico (HIGH, sin sospecha; candidatas, no veredictos)', i => diagnosticAcceptedEdges(i.run)], ['aceptadas (SOSTENIDA), contexto', acceptedEdges], ['con sonda de cobertura ejecutada, contexto', i => probedEdges(i.run)]];
    for (const [label, pick] of sets) {
      const scores = tpcds.map(i => scoreTpcdsCandidates(pick(i), gold));
      out.push(`### Candidatas ${label}`, '', table(['Metrica', ...tpcds.map(i => String(i.run.runId))], [
        ['Candidatas unicas', ...scores.map(s => String(s.candidates))],
        ['Aciertos (verdaderos positivos)', ...scores.map(s => of(s.truePositives, s.candidates))],
        ['Precision', ...scores.map(s => s.precision === null ? `no calculable (${s.precisionReason})` : `${pct(s.precision)} (${of(s.truePositives, s.candidates)})`)],
        ['Recall', ...scores.map(s => s.recall === null ? 'no calculable' : `${pct(s.recall)} (${of(s.truePositives, s.goldEdges)})`)],
        ['Aristas invertidas', ...scores.map(s => String(s.reversed.length))],
        ['Trampas de homonimos entre las candidatas', ...scores.map(s => `${of(s.trapsProposed.length, s.trapsInGold)}${s.trapsProposed.length ? `: ${s.trapsProposed.join(', ')}` : ''}`)],
        ['  de ellas, declaradas antes del run', ...scores.map(s => of(s.trapsProposedPredeclared.length, s.trapsPredeclared))],
      ]), '');
    }
    out.push('Las claves compuestas del gold no se puntuan con candidatas de una sola columna.');
    const skipped = inputs.length - tpcds.length;
    if (skipped) out.push(`${skipped} de ${inputs.length} corridas no son del universo TPCDS y no se evaluan contra este gold.`);
  }
  return scrub(out.join('\n') + '\n');
}

export function writeAgentRunsComparison(ids: string[], runsDir = path.join(ROOT, '.concordia', 'agent-runs')): { dir: string; files: string[] } {
  if (ids.length < 2) throw new SafeError('AGENT_COMPARE_NEEDS_TWO_RUNS');
  for (const id of ids) if (!RUN_ID.test(id)) throw new SafeError('AGENT_REPORT_RUN_ID_INVALID');
  const inputs = ids.map(id => {
    const run = readEngineRun(runsDir, id);
    let artifacts: unknown;
    try { if (typeof run.artifactsFile === 'string') artifacts = JSON.parse(fs.readFileSync(path.join(runsDir, id, path.basename(run.artifactsFile)), 'utf8')); } catch { artifacts = undefined; }
    return { run, artifacts };
  });
  const name = `compare-multi-${ids.join('_').slice(0, 170)}.md`;
  fs.writeFileSync(path.join(runsDir, name), renderAgentRunsComparisonMarkdown(inputs));
  return { dir: runsDir, files: [name] };
}
