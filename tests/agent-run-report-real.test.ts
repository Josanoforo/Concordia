import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/runtime.ts';
import { stageMetrics, efficiencyRows, writeAgentRunReport, renderAgentRunMarkdown, renderAgentRunComparisonMarkdown, writeAgentRunComparison } from '../src/report/agent-run-report.ts';

// Fixtures saneadas (recibos sinteticos, filas recortadas) de los runs LIVE agent-u1-live-01 y agent-u2-live-02, versionadas para que corran en cualquier copia.
const IN = path.join(ROOT, 'tests', 'fixtures', 'agent-runs');
const load = (id: string) => {
  const d = path.join(IN, id);
  assert.ok(fs.existsSync(path.join(d, "engine-run.json")), "fixture missing: " + id);
  const read = (f: string) => fs.existsSync(path.join(d, f)) ? fs.readFileSync(path.join(d, f), 'utf8') : undefined;
  return { dir: d, run: JSON.parse(read('engine-run.json')!), artifacts: read('artifacts.json') ? JSON.parse(read('artifacts.json')!) : undefined, log: read('adaptive-decisions.jsonl')?.trim().split('\n').map(l => JSON.parse(l)) };
};
const u1 = load('agent-u1-live-01'), u2 = load('agent-u2-live-02');

test('F-07: real U1 postComa renders its own table with coverage denominators', () => {
  const md = renderAgentRunMarkdown(u1!.run, u1!.artifacts);
  assert.match(md, /## Post-COMA/);
  assert.match(md, /taxi_zones\.borough__zones\.borough \| NY_TAXI\.taxi_zones\.borough \| NY_TAXI\.zones\.borough/);
  assert.match(md, /4 de 5 valores sondeados \(5 de 6 muestreados\)/);
  assert.match(md, /12 de 12 valores sondeados/);
  assert.match(md, /NOT_EXECUTABLE: NO_SAFE_SAMPLED_VALUES/);
  assert.match(md, /Sondas ejecutadas\*\*: 2 de 8/);
  assert.ok(!md.includes('...'), 'no truncated JSON blobs');
  assert.ok(!/[A-Za-z]:[\/]/.test(md), 'no absolute paths');
});

test('F-07: real U2 postComa (suggested only) and artifact detail', () => {
  const md = renderAgentRunMarkdown(u2!.run, u2!.artifacts);
  assert.match(md, /ENDPOINT_OUTSIDE_ALLOWLIST_OR_UNDISCOVERED/);
  assert.match(md, /Sondas ejecutadas\*\*: 0 de 1/);
  assert.match(md, /Detalle de probes \(3\)/);
  assert.match(md, /cik_text_trap \| SEC_DATA\.apple_revenue_facts\.cik \| SEC_DATA\.apple_submissions_raw\.cik \| INDETERMINADA \| endpoint_evidence_missing \| text \| REVALIDATED/);
  assert.match(md, /probes \| 3 elementos/);
});

test('F-07: comparison of two real runs states different universes and uses denominators', () => {
  const md = renderAgentRunComparisonMarkdown(u1!.run, u2!.run);
  assert.match(md, /Universos distintos/);
  assert.match(md, /Tokens \| 22765 de 15000 \| 3591 de 7000/);
  assert.match(md, /INDETERMINADA: 6 de 6/);
  assert.match(md, /Limites agotados \| tokens \| ninguno/);
  assert.match(md, /yellow_pu_taxi_zones \| INDETERMINADA \(evidence_incomplete_or_truncated\) \| no presente en este run \| no comparable/);
  const dir = path.join(ROOT, '.concordia', 'test-agent-report', 'compare');
  fs.rmSync(dir, { recursive: true, force: true });
  for (const r of [u1!, u2!]) { const d = path.join(dir, r.run.runId); fs.mkdirSync(d, { recursive: true }); fs.copyFileSync(path.join(r.dir, 'engine-run.json'), path.join(d, 'engine-run.json')); }
  const out = writeAgentRunComparison('agent-u1-live-01', 'agent-u2-live-02', dir);
  assert.deepEqual(out.files, ['compare-agent-u1-live-01-vs-agent-u2-live-02.md']);
  assert.ok(fs.existsSync(path.join(dir, out.files[0])));
  assert.throws(() => writeAgentRunComparison('agent-u1-live-01', 'nope', dir), /AGENT_REPORT_ENGINE_RUN_NOT_FOUND/);
});

test('L-04: invalid model response is linked to its adaptive-decisions.jsonl line', () => {
  const md = renderAgentRunMarkdown(u1!.run, u1!.artifacts, { decisionLog: u1!.log });
  assert.match(md, /## Respuestas invalidas del modelo \(1 de 2 llamadas\)/);
  assert.match(md, /select_bounded_read_2 \| U2_ADAPTIVE_RESPONSE_NOT_JSON \| adaptive-decisions\.jsonl, linea 2 \| 1305 caracteres \| Let me analyze/);
  assert.match(md, /\[\.\.\.\]/);
  const none = renderAgentRunMarkdown(u1!.run, u1!.artifacts);
  assert.match(none, /sin entrada para esta llamada/);
  assert.ok(!/Respuestas invalidas/.test(renderAgentRunMarkdown(u2!.run, u2!.artifacts, { decisionLog: u2!.log })), 'valid run has no section');
});

test('L-04: writeAgentRunReport reads the log from the run folder', () => {
  const dir = path.join(ROOT, '.concordia', 'test-agent-report', 'l04'), d = path.join(dir, 'agent-u1-live-01');
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
  for (const f of ['engine-run.json', 'adaptive-decisions.jsonl']) fs.copyFileSync(path.join(u1!.dir, f), path.join(d, f));
  writeAgentRunReport('agent-u1-live-01', dir);
  assert.match(fs.readFileSync(path.join(d, 'report.md'), 'utf8'), /adaptive-decisions\.jsonl, linea 2/);
  assert.match(fs.readFileSync(path.join(d, 'report.html'), 'utf8'), /adaptive-decisions\.jsonl, linea 2/);
});

test('E-08: why-view joins each verdict to its strategy and evidence', () => {
  const md = renderAgentRunMarkdown(u1!.run, u1!.artifacts);
  assert.match(md, /## Por que cada veredicto/);
  assert.match(md, /yellow_pu_taxi_zones \| INDETERMINADA \| evidence_incomplete_or_truncated \| propuesta: heuristic-configured; comparacion: integer \| evidencia INCOMPLETE; 13 de 13 claves sondeadas coinciden; 2 consultas; frescura INCOMPLETE; alertas: DUPLICATE_REFERENCED_KEYS/);
  const md2 = renderAgentRunMarkdown(u2!.run, u2!.artifacts);
  assert.match(md2, /cik_text_trap \| INDETERMINADA \| endpoint_evidence_missing \| propuesta: heuristic-configured; comparacion: text/);
  const noArt = renderAgentRunMarkdown(u2!.run);
  assert.match(noArt, /cik_text_trap \| INDETERMINADA \| endpoint_evidence_missing \| no disponible en este run \| no disponible en este run \| sin artifact de esta relacion/);
  assert.ok(!/[A-Za-z]:[\/]/.test(md + md2));
});

test('E-11: per-stage metrics are the same rows in every run and carry denominators', () => {
  const m1 = stageMetrics(u1!.run, u1!.artifacts), m2 = stageMetrics(u2!.run, u2!.artifacts);
  assert.deepEqual(m1.map(m => m[0] + '/' + m[1]), m2.map(m => m[0] + '/' + m[1]), 'same stage/metric keys');
  const get = (m: typeof m1, k: string) => m.find(x => x[0] + '/' + x[1] === k)![2];
  assert.equal(get(m1, 'X Exploracion/Tokens del modelo'), '22765 de 15000');
  assert.equal(get(m2, 'X Exploracion/Tokens del modelo'), '3591 de 7000');
  assert.equal(get(m1, 'X Exploracion/Llamadas validas'), '1 de 2');
  assert.equal(get(m2, 'X Exploracion/Llamadas validas'), '2 de 2');
  assert.equal(get(m1, 'S Sondas/Relaciones sondeadas'), '6 de 6');
  assert.equal(get(m1, 'S Sondas/Consultas de evidencia'), '12');
  assert.equal(get(m1, 'V Veredictos/Veredictos'), 'INDETERMINADA 6 de 6');
  assert.equal(get(m1, 'P Post-COMA/Sondas ejecutadas'), '2 de 8');
  assert.equal(get(stageMetrics(u1!.run), 'S Sondas/Consultas de evidencia'), 'no disponible en este run');
  const md = renderAgentRunComparisonMarkdown(u1!.run, u2!.run, { a: u1!.artifacts, b: u2!.artifacts });
  assert.match(md, /## Metricas por etapa/);
  assert.match(md, /X Exploracion \| Tokens del modelo \| 22765 de 15000 \| 3591 de 7000/);
  assert.match(renderAgentRunMarkdown(u2!.run, u2!.artifacts), /X Exploracion \| Llamadas validas \| 2 de 2/);
  assert.ok(!/\d%/.test(md), 'no percentages');
});

test('Efficiency: tokens per decision, caps, SQL per relation, receipts, no invented cost', () => {
  const md = renderAgentRunMarkdown(u2!.run, u2!.artifacts);
  assert.match(md, /## Eficiencia/);
  assert.match(md, /Tokens del modelo\*\*: 3591 de 7000 del tope/);
  assert.match(md, /Tokens por decision del modelo\*\*: 1796 \(3591 tokens en 2 decisiones; 2 validas\)/);
  assert.match(md, /Consultas SQL\*\*: 10 de 25 del tope/);
  assert.match(md, /SQL por relacion decidida\*\*: 3\.3 \(10 consultas en 3 relaciones\)/);
  assert.match(md, /rcpt_fixture_3 \(claude-sonnet-5, 1585 tokens\)/);
  assert.match(md, /Costo\*\*: costo no registrado en este run/);
  const cmp = renderAgentRunComparisonMarkdown(u1!.run, u2!.run);
  assert.match(cmp, /## Eficiencia/); assert.match(cmp, /Tokens del modelo \| 22765 de 15000 del tope \| 3591 de 7000 del tope/);
  const withCost = { ...u2!.run, budget: { ...u2!.run.budget, used: { ...u2!.run.budget.used, costUsd: 0.01 } } };
  assert.match(renderAgentRunMarkdown(withCost), /Costo\*\*: costUsd: 0\.01/);
});

test('L-02: the 6 incomplete U1 probes are typed EXPECTED_SAMPLE_CAP (recomputed from stored evidence); verdicts unchanged', () => {
  const md = renderAgentRunMarkdown(u1!.run, u1!.artifacts);
  assert.match(md, /Tipo de incompletitud \(6 sondas/);
  assert.equal((md.match(/EXPECTED_SAMPLE_CAP \| truncada por el tope de muestra \(LIMIT 50\)/g) ?? []).length, 6);
  assert.equal(u1!.artifacts.probes.filter((p: any) => p.verdict === 'INDETERMINADA').length, 6);
});

test('L-02: stored incompleteness wins; unavailable evidence says "no disponible"; labels per kind', () => {
  const mk = (probe: any) => renderAgentRunMarkdown(u1!.run, { probes: [{ relationId: 'r1', verdict: 'INDETERMINADA', rule: 'evidence_incomplete_or_truncated', ...probe }] });
  assert.match(mk({ incompleteness: { kind: 'EXECUTION_FAILURE', detail: {} } }), /EXECUTION_FAILURE \| incompleta por fallo de ejecucion/);
  assert.match(mk({ incompleteness: { kind: 'ENDPOINT_MISSING', detail: { missingEndpoints: ['src_b'] } } }), /ENDPOINT_MISSING \| extremo ausente \(src_b\)/);
  assert.match(mk({}), /r1 \| no disponible en este run \| no disponible/);
});

test('R-02/R-12: optional alternatives table and typed actions; old runs render unchanged', () => {
  const run = { ...u2!.run, joins: { alternatives: [
    { choice: 'SIC_CODE', from: 'a.x', to: 'b.y', normalization: 'text', nSource: 10, nTarget: 8, matchedSourceRows: 4, matchPairs: 5, ambiguousSourceRows: 1, fieldAvailability: 'AVAILABLE' },
    { choice: 'NO_JOIN', from: 'none', to: 'none', normalization: 'none', nSource: 10, nTarget: 8, matchedSourceRows: null, matchPairs: null, ambiguousSourceRows: null, fieldAvailability: 'NOT_APPLICABLE' }] },
    phases: { ...u2!.run.phases, exploration: { ...(u2!.run.phases?.exploration ?? {}), actions: [
      { step: 1, action: 'CMP', reason: 'r', execution: 'PASS', observation: { rows: 3, summary: { kind: 'COMPARE_KEYS', observedKeys: 5, present: ['a', 'b', 'c'], missing: ['d', 'e'] } } },
      { step: 2, action: 'AGG', reason: 'r', execution: 'PASS', observation: { rows: 2, summary: { kind: 'AGGREGATE_COUNT', counts: { a: 2, b: 1 }, keysWithRows: 2, keysWithoutRows: ['c'] } } },
      { step: 3, action: 'READ', reason: 'r', execution: 'PASS', observation: { rows: 4 } }] } } };
  const md = renderAgentRunMarkdown(run, u2!.artifacts);
  assert.match(md, /Alternativas de union comparadas \(2\)/);
  assert.match(md, /SIC_CODE \| a\.x \| b\.y \| text \| 4 de 10 \| 5 \| 1 \| AVAILABLE/);
  assert.match(md, /COMPARE_KEYS \| PASS \| r \| 3 \| presentes 3 de 5; ausentes 2/);
  assert.match(md, /AGGREGATE_COUNT \| PASS \| r \| 2 \| claves con filas 2 de 3/);
  assert.match(md, /READ \| KEYED_READ \| PASS/);
  assert.ok(!renderAgentRunMarkdown(u2!.run, u2!.artifacts).includes('Alternativas de union'));
  assert.ok(!renderAgentRunMarkdown(u2!.run, u2!.artifacts).includes('Resumen'));
});

test('R-02: the engine stage phases.joinComparison feeds the alternatives table, and a budget skip is stated', () => {
  const alt = { choice: 'CUSTOMER_ID', from: 'orders.customer_id', to: 'customers.customer_id', normalization: 'text', nSource: 6, nTarget: 4, matchedSourceRows: 5, matchPairs: 5, ambiguousSourceRows: 0, fieldAvailability: 'AVAILABLE' };
  const compared = { ...u2!.run, phases: { ...u2!.run.phases, joinComparison: { status: 'COMPARED', alternatives: [alt] } } };
  assert.match(renderAgentRunMarkdown(compared, u2!.artifacts), /CUSTOMER_ID \| orders\.customer_id \| customers\.customer_id \| text \| 5 de 6 \| 5 \| 0 \| AVAILABLE/);
  const skipped = { ...u2!.run, phases: { ...u2!.run.phases, joinComparison: { status: 'NOT_EXECUTED_BUDGET' } } };
  assert.match(renderAgentRunMarkdown(skipped, u2!.artifacts), /Alternativas de union: no ejecutadas por presupuesto/);
});
