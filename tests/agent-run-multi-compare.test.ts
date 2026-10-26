import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from '../src/runtime.ts';
import { renderAgentRunsComparisonMarkdown, writeAgentRunsComparison } from '../src/report/agent-run-multi-compare.ts';
import { loadTpcdsGold } from '../src/eval/tpcds-gold.ts';

const gold = loadTpcdsGold(), edge = gold.edges[0]!, trap = gold.homonymTraps[0]!;
const ep = (e: { table: string; column: string }) => ({ db: 'TPCDS_DB', table: e.table, column: e.column });
const probe = (id: string, from: any, to: any) => ({ relationId: id, from: ep(from), to: ep(to) });
const mk = (runId: string, over: object = {}) => ({ runId, universeId: 'TPCDS', executionMode: 'LIVE', dataOrigin: 'PUBLIC', status: 'COMPLETED', modelParticipation: 'USED',
  phases: { exploration: { calls: [{ decisionStatus: 'VALID' }, { decisionStatus: 'INVALID_RESPONSE' }] }, probes: { selected: ['r1', 'r2'] } },
  budget: { used: { tokens: 1200, queries: 40 }, limits: { maxTokensPerRun: 50000, maxQueriesPerRun: 100 } },
  postComa: { proposals: [{ proposalId: 'p1', from: edge.from, to: edge.to, coverageProbe: { status: 'EXECUTED', diagnostic: { coverage: { level: 'HIGH' }, suspect: { value: false } } } }, { proposalId: 'p2', from: trap.a, to: trap.b, coverageProbe: { status: 'EXECUTED', diagnostic: { coverage: { level: 'HIGH' }, suspect: { value: true, reasons: ['X'] } } } }, { proposalId: 'p3', from: edge.to, to: edge.from, coverageProbe: { status: 'SUGGESTED' } }] },
  decisions: [{ relationId: 'r1', verdict: 'SOSTENIDA' }, { relationId: 'r2', verdict: 'SOSTENIDA', reused: { fromRunId: 'x' } }, { relationId: 'r3', verdict: 'INDETERMINADA' }],
  memory: { status: 'RECORDED', claims: [{ id: 'c1', firstRunId: runId }, { id: 'c2', firstRunId: 'older-run' }] }, ...over });
const arts = { probes: [probe('r1', edge.from, edge.to), probe('r2', trap.a, trap.b), probe('r3', edge.to, edge.from)] };

test('M8-4: N-run table has mode/origin, status, participation, valid calls, tokens, queries, probes, claims and reuse with denominators', () => {
  const md = renderAgentRunsComparisonMarkdown([{ run: mk('run-a'), artifacts: arts }, { run: mk('run-b', { executionMode: 'LOCAL', dataOrigin: 'FOO', status: 'DEGRADED', modelParticipation: 'FAILED', memory: { status: 'SKIPPED', claims: [] } }), artifacts: arts }, { run: mk('run-c', { postComa: undefined, memory: undefined }), artifacts: arts }]);
  assert.match(md, /# Comparacion de 3 corridas/);
  assert.match(md, /\| Metrica \| run-a \| run-b \| run-c \|/);
  assert.match(md, /\| Modo de ejecucion \| LIVE \| LOCAL \| LIVE \|/); assert.match(md, /\| Origen de datos \| PUBLIC \| UNKNOWN \| PUBLIC \|/);
  assert.match(md, /\| Estado \| COMPLETED \| DEGRADED \| COMPLETED \|/); assert.match(md, /\| Participacion del modelo \| USED \| FAILED \| USED \|/);
  assert.match(md, /\| Llamadas con decision valida \| 1 de 2 \|/); assert.match(md, /\| Tokens \(usados \/ tope\) \| 1200 de 50000/);
  assert.match(md, /\| Sondas de cobertura post-COMA ejecutadas \| 2 de 3 \| 2 de 3 \| no disponible en este run \|/);
  assert.match(md, /\| Relaciones aceptadas \(SOSTENIDA \/ decisiones\) \| 2 de 3 \|/); assert.match(md, /\| Claims en memoria tras el run \| 2 claims \(nuevos de este run 1 de 2; previos 1 de 2; memoria RECORDED\) \| 0 claims \(nuevos de este run 0 \(sin denominador\); previos 0 \(sin denominador\); memoria SKIPPED\) \| no disponible en este run \|/);
  assert.match(md, /\| Decisiones reusadas de memoria \| 1 de 3 \|/);
});

test('M8-4: TPCDS gold evaluation is a labelled section with precision/recall denominators, reversed edges and accepted traps', () => {
  const md = renderAgentRunsComparisonMarkdown([{ run: mk('run-a'), artifacts: arts }, { run: mk('run-o', { universeId: 'GTFS' }), artifacts: arts }]);
  assert.match(md, /## Evaluacion fuera del runtime/);
  const accepted = md.slice(md.indexOf('### Candidatas aceptadas (SOSTENIDA)'), md.indexOf('### Candidatas con sonda'));
  assert.match(accepted, /\| Candidatas unicas \| 2 \|/); assert.match(accepted, /\| Aciertos \(verdaderos positivos\) \| 1 de 2 \|/);
  assert.match(accepted, new RegExp(`\\| Precision \\| 50\\.0% \\(1 de 2\\) \\|`)); assert.match(accepted, new RegExp(`\\| Recall \\| ${(100 / gold.edges.length).toFixed(1)}% \\(1 de ${gold.edges.length}\\) \\|`));
  assert.match(accepted, new RegExp(`Trampas de homonimos entre las candidatas \\| 1 de ${gold.homonymTraps.length}: ${trap.id.replace(/[.~]/g, '\\$&')}`));
  const diag = md.slice(md.indexOf('### Candidatas aceptadas por diagnostico (HIGH, sin sospecha; candidatas, no veredictos)'), md.indexOf('### Candidatas aceptadas (SOSTENIDA)'));
  assert.ok(md.indexOf('### Candidatas aceptadas por diagnostico') < md.indexOf('### Candidatas aceptadas (SOSTENIDA)'), 'diagnostic set is the main row');
  assert.match(diag, /| Candidatas unicas | 1 |/); assert.match(diag, /| Precision | 100.0% (1 de 1) |/); assert.match(diag, new RegExp(`\| Recall \| ${(100 / gold.edges.length).toFixed(1)}% \(1 de ${gold.edges.length}\) \|`)); assert.match(diag, /Trampas de homonimos entre las candidatas | 0 de/);
  const probed = md.slice(md.indexOf('### Candidatas con sonda'));
  assert.match(probed, /\| Candidatas unicas \| 2 \|/);
  assert.match(md, /1 de 2 corridas no son del universo TPCDS/);
  const none = renderAgentRunsComparisonMarkdown([{ run: mk('g1', { universeId: 'GTFS' }) }, { run: mk('g2', { universeId: 'GTFS' }) }]);
  assert.ok(!none.includes('Evaluacion fuera del runtime'));
});

test('M8-4: a run with no accepted candidates has uncomputable precision (not 0%); needs two runs; writes a file next to the runs', () => {
  const md = renderAgentRunsComparisonMarkdown([{ run: mk('n1', { decisions: [] }), artifacts: arts }, { run: mk('n2', { decisions: [] }), artifacts: arts }]);
  assert.match(md, /\| Precision \| no calculable \(NO_CANDIDATES\) \|/);
  assert.throws(() => renderAgentRunsComparisonMarkdown([{ run: mk('only') }]), /AGENT_COMPARE_NEEDS_TWO_RUNS/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-'));
  try {
    for (const id of ['w1', 'w2', 'w3']) { fs.mkdirSync(path.join(dir, id)); fs.writeFileSync(path.join(dir, id, 'engine-run.json'), JSON.stringify(mk(id))); }
    const out = writeAgentRunsComparison(['w1', 'w2', 'w3'], dir);
    assert.deepEqual(out.files, ['compare-multi-w1_w2_w3.md']);
    assert.match(fs.readFileSync(path.join(dir, out.files[0]!), 'utf8'), /\| Metrica \| w1 \| w2 \| w3 \|/);
    assert.throws(() => writeAgentRunsComparison(['w1', '../x'], dir), /AGENT_REPORT_RUN_ID_INVALID/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('M8-4: the agent runtime never imports the gold (nor the evaluator that reads it)', () => {
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.ts') ? [path.join(d, e.name)] : []);
  const offenders = walk(path.join(ROOT, 'src', 'agent')).filter(f => /tpcds-gold|TPCDS_fk_gold|eval\/gold|multi-compare/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders.map(f => path.relative(ROOT, f).split(path.sep).join('/')), []);
});
