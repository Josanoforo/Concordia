import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/runtime.ts';
import { stageMetrics, efficiencyRows, writeAgentRunReport, renderAgentRunMarkdown, renderAgentRunHtml, renderAgentRunComparisonMarkdown, writeAgentRunComparison } from '../src/report/agent-run-report.ts';

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
  assert.match(md, /Tokens por decision del modelo\*\*: 1796 \(3591 tokens de 2 llamadas con recibo, entre 2 decisiones validas con recibo; 2 llamadas en total\)/);
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

test('M4-4: coverage, abstention and risk with denominators; risk not measurable on real runs', () => {
  const md = renderAgentRunMarkdown(u1!.run, u1!.artifacts);
  assert.match(md, /## Cobertura y riesgo/);
  assert.match(md, /Cobertura \(decididas \/ relaciones configuradas\)\*\*: 0 de 6/);
  assert.match(md, /Tasa de abstencion \(INDETERMINADA \/ relaciones configuradas\)\*\*: 6 de 6/);
  assert.match(md, /Riesgo \(falsas aceptaciones \/ aceptadas\)\*\*: no medible sin adjudicacion \(0 de 6 aceptadas\)/);
  const mixed = { ...u1!.run, decisions: [{ relationId: 'a', verdict: 'SOSTENIDA' }, { relationId: 'b', verdict: 'ENGAÑOSA' }, { relationId: 'c', verdict: 'INDETERMINADA' }, { relationId: 'd', verdict: 'SOSTENIDA' }] };
  const m2 = renderAgentRunMarkdown({ ...mixed, phases: { ...mixed.phases, discovery: { ...mixed.phases.discovery, relations: ['a', 'b', 'c', 'd', 'e', 'f'] } } });
  assert.match(m2, /Cobertura \(decididas \/ relaciones configuradas\)\*\*: 3 de 6/); assert.match(m2, /abstencion[^\n]*: 1 de 6/); assert.match(m2, /\(2 de 6 aceptadas\)/); assert.match(m2, /Sin decision \(configuradas sin veredicto en este run\)\*\*: 2 de 6/);
  assert.match(renderAgentRunMarkdown({ ...u1!.run, decisions: [] }), /Sin decisiones: no hay cobertura/);
});

const final = load('agent-u2-final-live-01');

test('R5-4: per-call model telemetry table (receipt, route requested/routed, reason, tokens in/out, latency, cache) on real U2 runs', () => {
  for (const [r, ids] of [[u2!, ['rcpt_fixture_3', 'rcpt_fixture_4']], [final!, ['rcpt_fixture_11', 'rcpt_fixture_12']]] as const) {
    const md = renderAgentRunMarkdown(r.run, r.artifacts);
    assert.match(md, /## Telemetria del modelo por llamada/);
    for (const id of ids) assert.match(md, new RegExp(`\| ${id} \| anthropic / claude-sonnet-5 \| cheap \| cheap \(claude-sonnet-5\) \| latency-hedge \(learned-router\) \| \d+ / \d+ \| \d+ ms \| no \|`));
    assert.ok(!/rcpt_req_/.test(md) && !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(md));
  }
  assert.ok(!renderAgentRunMarkdown(u1!.run, u1!.artifacts).includes('Telemetria del modelo') === !u1!.run.phases.exploration?.calls?.some((c: any) => c.receipt?.receiptId));
});

test('R5-4: model explanations are shown apart, with receipt, labelled non-decisional; absent in old runs', () => {
  const arts = { ...final!.artifacts, probes: final!.artifacts.probes.map((p: any, i: number) => i === 0 ? { ...p, llmExplanation: 'El modelo describe la muestra.', llmReceipt: { receiptId: 'rcpt_fixture_99', model: 'claude-sonnet-5' } } : p) };
  const md = renderAgentRunMarkdown(final!.run, arts);
  assert.match(md, /## Explicaciones del modelo \(no decisorias\)/);
  assert.match(md, /No decisoria: el texto lo escribio el modelo/);
  assert.match(md, new RegExp(`\| ${arts.probes[0].relationId} \| rcpt_fixture_99 \| claude-sonnet-5 \| El modelo describe la muestra\. \|`));
  assert.ok(md.indexOf('## Explicaciones del modelo') > md.indexOf('## Por que cada veredicto'), 'apart from the verdict table');
  assert.ok(!renderAgentRunMarkdown(final!.run, final!.artifacts).includes('Explicaciones del modelo'));
});

test('R5-5/R5-3/M4-3/R5-2: BOUNDED_PROFILE summary, phase budget, source-query breakdown and assisted critic; old runs unchanged', () => {
  const base = final!.run;
  const run = { ...base,
    phases: { ...base.phases, exploration: { ...base.phases.exploration, actions: [
      { step: 1, action: 'PROFILE', reason: 'r', execution: 'PASS', observation: { rows: 1, summary: { kind: 'BOUNDED_PROFILE', rows: 50, distinct: 40, nulls: 2, limit: 50, bounded: true } } },
      { step: 2, action: 'PROFILE2', reason: 'r', execution: 'PASS', observation: { rows: 1, summary: { kind: 'BOUNDED_PROFILE', rows: 12, distinct: 12, nulls: 0, limit: 50, bounded: false } } }] } },
    budget: { ...base.budget, used: { ...base.budget.used, preflightQueries: 2, discoveryQueries: 4, totalSourceQueries: 16 },
      phases: { enabled: true, shares: { exploration: 0.5 }, byPhase: { exploration: { allocated: { queries: 10, tokens: 3000 }, transferredIn: { queries: 0, tokens: 0 }, used: { queries: 6, tokens: 2500 } }, probes: { used: { queries: 4, tokens: 0 } } } } },
    criticAssist: { status: 'ASSISTED', call: { made: true, receipt: { receiptId: 'rcpt_fixture_50', model: 'claude-sonnet-5', totalTokens: 900 } }, suggested: [{ relationId: 'a', id: 'X' }, { relationId: 'b', id: 'Y' }], executed: [{ relationId: 'a', id: 'X' }], rejected: [{ id: 'Z', reason: 'UNKNOWN_COUNTERPROBE_ID' }], degradedRelationIds: ['a'] } };
  const md = renderAgentRunMarkdown(run, final!.artifacts);
  assert.match(md, /filas 50, distintos 40, nulos 2 \(acotado a LIMIT 50\)/);
  assert.match(md, /filas 12, distintos 12, nulos 0 \(bajo el LIMIT 50\)/);
  assert.match(md, /Consultas al origen: 16 en total = \d+ con tope \+ 2 de preflight \+ 4 de descubrimiento/);
  assert.match(md, /Presupuesto por fase \(activo/);
  assert.match(md, /\| exploration \| 10 consultas \/ 3000 tokens \| 0 consultas \/ 0 tokens \| 6 consultas \/ 2500 tokens \|/);
  assert.match(md, /\| probes \| - \| - \| 4 consultas \/ 0 tokens \|/);
  assert.match(md, /## Critico asistido por el modelo/);
  assert.match(md, /Recibo\*\*: rcpt_fixture_50 \(claude-sonnet-5, 900 tokens\)/);
  assert.match(md, /Ejecutadas\*\*: 1 de 2/);
  assert.match(md, /Relaciones degradadas\*\*: 1 de 3: a/);
  const old = renderAgentRunMarkdown(final!.run, final!.artifacts);
  for (const absent of ['Consultas al origen', 'Presupuesto por fase', 'Critico asistido', 'BOUNDED_PROFILE']) assert.ok(!old.includes(absent), absent);
});

test('P3 blind post-COMA: candidates section ordered HIGH-clean, LABEL_CONFLICT, rest, labelled not-a-verdict; not-executed table with denominator; absent in old runs', () => {
  const diag = (level: string, matched: number, probed: number, signal: string, suspect: string[], extra: object = {}) => ({ coverageProbe: { status: 'EXECUTED', diagnostic: {
    coverage: { level, matched, probed, threshold: 0.8 }, labels: signal === 'LABELS_AGREE' || signal === 'LABEL_CONFLICT' ? { signal, agree: signal === 'LABEL_CONFLICT' ? 0 : 3, compared: 3 } : { signal, reason: 'NO_LABEL_COLUMNS_DECLARED' },
    multiplicity: { from: { maxRowsPerKey: 1 }, to: { maxRowsPerKey: 2 } }, containment: { aToB: { shared: matched, of: probed, ratio: 1 }, reason: 'TARGET_FILTERED_BY_SOURCE_KEYS' },
    keyRules: { inclusion: { status: 'ALL_SOURCE_KEYS_PRESENT', checkedKeys: probed, missingCount: probed - matched }, targetUniqueness: { status: 'NO_DUPLICATES_IN_SAMPLE', duplicateKeyCount: 0 } },
    suspect: { value: suspect.length > 0, reasons: suspect }, governance: 'CANDIDATE_REQUIRES_REVIEW', counterfactual: `cf-${level}-${signal}`, ...extra } } });
  const prop = (id: string, score: number, d: object) => ({ proposalId: id, from: { table: id.split('__')[0]!.split('.')[0], column: id.split('__')[0]!.split('.')[1] }, to: { table: id.split('__')[1]!.split('.')[0], column: id.split('__')[1]!.split('.')[1] }, rawScore: score, verificationStatus: 'NO VERIFICADO/UNKNOWN', reviewState: 'PENDING', ...d });
  const postComa = { status: 'PARTIAL', policy: { maxProbes: 3 }, counts: { proposals: 5, executed: 4 },
    proposals: [prop('a.k__b.k', 0.9, diag('NONE', 0, 4, 'NOT_COMPARABLE', ['NO_COVERAGE'])), prop('c.k__d.k', 0.8, diag('HIGH', 3, 3, 'LABEL_CONFLICT', ['LABEL_CONFLICT'])),
      prop('e.k__f.k', 0.7, diag('HIGH', 4, 4, 'NOT_COMPARABLE', [])), prop('g.k__h.k', 0.6, diag('LOW', 1, 4, 'NOT_COMPARABLE', ['LOW_COVERAGE'])), prop('i.k__j.k', 0.5, { coverageProbe: { status: 'SKIPPED_BUDGET' } })],
    notExecutedByBudget: [{ proposalId: 'i.k__j.k', rawScore: 0.5, reason: 'QUERY_BUDGET_INSUFFICIENT' }] };
  const md = renderAgentRunMarkdown({ ...u2!.run, postComa }, u2!.artifacts);
  assert.match(md, /## Candidatas descubiertas \(requieren revision\)/);
  assert.match(md, /candidata, no veredicto: CANDIDATE_REQUIRES_REVIEW\. 4 candidatas/);
  const order = ['e.k -> f.k', 'c.k -> d.k', 'a.k -> b.k', 'g.k -> h.k'].map(t => md.indexOf(t, md.indexOf('## Candidatas descubiertas')));
  assert.ok(order.every(i => i > 0) && order.every((v, i) => i === 0 || v > order[i - 1]!), 'HIGH clean, then LABEL_CONFLICT, then the rest by score');
  assert.match(md, /HIGH: 4 de 4 valores; umbral 0\.8/);
  assert.match(md, /LABEL_CONFLICT: 0 de 3 etiquetas/);
  assert.match(md, /si: LABEL_CONFLICT/); assert.match(md, /cf-HIGH-LABEL_CONFLICT/);
  assert.match(md, /No ejecutadas por presupuesto: 1\. Ejecutadas 4 de 5 propuestas\./);
  assert.match(md, /\| i\.k__j\.k \| 0\.5 \| QUERY_BUDGET_INSUFFICIENT \|/);
  const old = renderAgentRunMarkdown(u2!.run, u2!.artifacts);
  assert.ok(!old.includes('Candidatas descubiertas') && !old.includes('No ejecutadas por presupuesto'));
});

test('R6 memory: claim tier, reusedBy, bi-temporal spans (unknown end), invalidation and the two new reprobe reasons; old claims unchanged', () => {
  const base = { schemaVersion: 1, status: 'RECORDED', runId: 'r', universeId: 'U', scope: 's', conflicts: [], reviewQueue: [], ledger: { entries: 1, appendOnly: true } };
  const claims = [
    { id: 'mem-1', relationId: 'a', attribute: 'verdict', value: 'SOSTENIDA', tier: 'reviewed', reusedBy: ['run-2', 'run-3'], validFrom: '2026-10-01T00:00:00Z', validTo: null, recordedAt: '2026-10-02T00:00:00Z', supersededAt: null, invalidated: false, invalidatedBy: null },
    { id: 'mem-2', relationId: 'b', attribute: 'verdict', value: 'SOSTENIDA', tier: 'observed', reusedBy: [], validFrom: '2026-10-03T00:00:00Z', validTo: '2026-10-09T00:00:00Z', recordedAt: '2026-10-03T00:00:00Z', supersededAt: '2026-10-10T00:00:00Z', invalidated: true, invalidatedBy: 'mem-9' }];
  const reuse = { mode: 'WARM', reprobe: [{ relationId: 'b', reason: 'INVALIDATED', currentVersion: 'v2' }, { relationId: 'c', reason: 'UNTRUSTED_PROVENANCE', rememberedVersion: 'v1', currentVersion: 'v1' }] };
  const md = renderAgentRunMarkdown({ ...u2!.run, memory: { ...base, claims, reuse } });
  assert.match(md, /\| mem-1 \| reviewed \| run-2, run-3 \| 2026-10-01T00:00:00Z a fin desconocido \| 2026-10-02T00:00:00Z a fin desconocido \| no \|/);
  assert.match(md, /\| mem-2 \| observed \| - \| 2026-10-03T00:00:00Z a 2026-10-09T00:00:00Z \| 2026-10-03T00:00:00Z a 2026-10-10T00:00:00Z \| si, por mem-9 \|/);
  assert.match(md, /Relaciones re-sondeadas en lugar de reutilizadas: 2\./);
  assert.match(md, /\| b \| INVALIDATED \| el claim sostenido fue invalidado/);
  assert.match(md, /\| c \| UNTRUSTED_PROVENANCE \| el claim no trae run ni recibos/);
  const legacy = renderAgentRunMarkdown({ ...u2!.run, memory: { ...base, claims: [{ id: 'old', relationId: 'a', attribute: 'verdict', value: 'SOSTENIDA', runIds: ['x'] }] } });
  assert.ok(!legacy.includes('Nivel y tiempos') && !legacy.includes('re-sondeadas'));
});

test('wide blind universe: COMA top-N, post-COMA executed-only table with counts, token-budget stop visible in Estado final; small runs unchanged', () => {
  const mk = (i: number) => ({ from: { table: `t${i}`, column: 'c' }, to: { table: `u${i}`, column: 'c' }, rawScore: i / 100, reason: 'COMA_COLUMN_PAIR_OUT_OF_SCOPE', verificationStatus: 'NO VERIFICADO/UNKNOWN', reviewState: 'PENDING' });
  const oos = Array.from({ length: 60 }, (_, i) => mk(i));
  const props = Array.from({ length: 70 }, (_, i) => ({ ...mk(i), proposalId: `p${i}__q${i}`, structure: { orientation: 'AS_PROPOSED' },
    coverageProbe: i < 3 ? { status: 'EXECUTED', result: { targetMatches: 1, probedValues: 1, sampledSourceValues: 1 }, diagnostic: { coverage: { level: 'HIGH' }, suspect: { value: i === 1, reasons: i === 1 ? ['LABEL_CONFLICT'] : [] } } } : i < 5 ? { status: 'NOT_EXECUTABLE', reason: 'X' } : { status: 'SUGGESTED' } }));
  const base = u2!.run;
  const run = { ...base, phases: { ...base.phases, coma: { ...base.phases.coma, outOfScopeProposals: oos }, exploration: { ...base.phases.exploration, plannerError: { code: 'TOKEN_BUDGET_WOULD_EXCEED', used: 0, estimated: 62573, limit: 50000 } } },
    postComa: { status: 'PARTIAL', policy: { maxProbes: 3 }, counts: { proposals: 70, executed: 3, suggested: 65, notExecutable: 2, skippedBudget: 0 }, proposals: props } };
  const md = renderAgentRunMarkdown(run, u2!.artifacts);
  assert.match(md, /Se listan las 20 de mayor puntaje crudo de 60 propuestas/);
  assert.ok(md.includes('| t59.c |') && !md.includes('| t10.c |'), 'top 20 by raw score only');
  assert.match(md, /Universo ancho: 70 propuestas\. Sugeridas sin sonda por el tope de sondas: 65 de 70; no ejecutables: 2 de 70; omitidas por presupuesto de consultas \(SKIPPED_BUDGET\): 0 de 70\. Solo se listan las 3 sondas ejecutadas/);
  assert.ok(md.includes('| p0__q0 |') && !md.includes('| p10__q10 |'));
  assert.match(md, /\| p1__q1 \|.*\| HIGH \| si: LABEL_CONFLICT \| AS_PROPOSED \|/);
  const estado = md.slice(0, md.indexOf('## Estado final'));
  assert.match(estado, /TOKEN_BUDGET_WOULD_EXCEED \(estimado 62573 tokens, limite 50000, usados 0\)/);
  const small = renderAgentRunMarkdown(u2!.run, u2!.artifacts);
  assert.ok(!small.includes('Universo ancho') && !small.includes('Se listan las 20') && !small.includes('El modelo NO participo'));
});

test('S3 model participation: banner first for FAILED/inferred, neutral line for NOT_REQUESTED, degradations list, modelRanking verbatim, old runs inferred', () => {
  const base = u2!.run, ex = (o: object) => ({ ...base.phases, exploration: { ...base.phases.exploration, ...o } });
  const top = (md: string) => md.slice(0, md.indexOf('## Estado final'));
  const failed = renderAgentRunMarkdown({ ...base, phases: ex({ calls: [] }), status: 'DEGRADED_NO_MODEL', modelParticipation: 'FAILED', modelParticipationReason: 'PROVIDER_TIMEOUT', degradations: [{ phase: 'exploration', code: 'PROVIDER_TIMEOUT', detail: 'sin respuesta' }, { phase: 'critic', code: 'SKIPPED' }] }, u2!.artifacts);
  assert.match(top(failed), /El modelo NO participo: PROVIDER_TIMEOUT\./);
  assert.match(failed, /Degradaciones: 2\./); assert.match(failed, /\| exploration \| PROVIDER_TIMEOUT \| sin respuesta \|/); assert.match(failed, /\| critic \| SKIPPED \| - \|/);
  const nr = renderAgentRunMarkdown({ ...base, modelParticipation: 'NOT_REQUESTED', phases: ex({ calls: [] }) }, u2!.artifacts);
  assert.match(top(nr), /El modelo no fue solicitado en este run \(--no-model\)\./); assert.ok(!nr.includes('El modelo NO participo'));
  const old = renderAgentRunMarkdown({ ...base, phases: ex({ calls: [], plannerError: { code: 'TOKEN_BUDGET_WOULD_EXCEED', used: 0, estimated: 9, limit: 5 } }) }, u2!.artifacts);
  assert.match(top(old), /El modelo NO participo: TOKEN_BUDGET_WOULD_EXCEED \(estimado 9 tokens, limite 5, usados 0\)/);
  const empty = renderAgentRunMarkdown({ ...base, phases: ex({ calls: [], plannerError: undefined }) }, u2!.artifacts);
  assert.match(top(empty), /El modelo NO participo: sin llamadas al modelo registradas/);
  assert.ok(!renderAgentRunMarkdown(base, u2!.artifacts).includes('El modelo NO participo'));
  const rk = renderAgentRunMarkdown({ ...base, probeSelection: { ...base.probeSelection, modelRanking: 'NOT_APPLICABLE_NO_CONFIGURED_PROBES' } }, u2!.artifacts);
  assert.match(rk, /Ranking de sondas por modelo\*\*: NOT_APPLICABLE_NO_CONFIGURED_PROBES/);
});

test('S3b: a DEGRADED run with the model USED still lists its degradations; the banner stays absent', () => {
  const md = renderAgentRunMarkdown({ ...u2!.run, status: 'DEGRADED', modelParticipation: 'USED', degradations: [{ phase: 'memory', code: 'MEMORY_ERROR', detail: 'ledger ilegible' }, { phase: 'coma', code: 'COMA_FAILED' }] }, u2!.artifacts);
  const top = md.slice(0, md.indexOf('## Estado final'));
  assert.ok(!top.includes('El modelo NO participo'));
  assert.match(top, /Degradaciones: 2\./); assert.match(top, /\| memory \| MEMORY_ERROR \| ledger ilegible \|/); assert.match(top, /\| coma \| COMA_FAILED \| - \|/);
  assert.match(md, /\*\*Estado\*\*: DEGRADED/);
});

test('G1: declared participation and ranking are cross-checked with the recorded calls; scrub keeps URLs and cuts only local paths', () => {
  const base = u2!.run;
  const bad = renderAgentRunMarkdown({ ...base, modelParticipation: 'USED', phases: { ...base.phases, exploration: { ...base.phases.exploration, calls: [] } } }, u2!.artifacts);
  assert.match(bad.slice(0, bad.indexOf('## Estado final')), /Inconsistencia: el run declara modelParticipation USED pero no registra ninguna llamada/);
  const bad2 = renderAgentRunMarkdown({ ...base, modelParticipation: 'NOT_REQUESTED' }, u2!.artifacts);
  assert.match(bad2.slice(0, bad2.indexOf('## Estado final')), /Inconsistencia: el run declara modelParticipation NOT_REQUESTED pero registra \d+ de \d+ llamadas con decision valida/);
  const r1 = renderAgentRunMarkdown({ ...base, probeSelection: { ...base.probeSelection, modelRanking: 'USED', calls: [] } }, u2!.artifacts);
  assert.match(r1, /usado \(inconsistente: el run declara USED pero no registra llamadas de ranking/);
  const r2 = renderAgentRunMarkdown({ ...base, probeSelection: { ...base.probeSelection, modelRanking: 'NOT_USED', calls: [{}] } }, u2!.artifacts);
  assert.match(r2, /no usado \(inconsistente: el run declara NOT_USED pero registra 1 llamadas/);
  const html = renderAgentRunHtml({ ...base, limitations: ['ver https://example.org/docs/page y C:\\Users\\x\\file.txt y D:/data/a.csv'] });
  assert.match(html, /https:\/\/example\.org\/docs\/page/); assert.ok(!html.includes('Users') && !html.includes('D:/data'));
});

test('scrub hides every local path form in markdown and HTML and keeps http(s) URLs', () => {
  const forms: [string, string][] = [
    ['C:\\Users\\jon\\secret\\a.txt', 'jon'], ['C:/Users/jon/secret/a.txt', 'jon'], ['c:\\Users\\jon\\a.txt', 'jon'],
    ['C:\\\\Users\\\\jon\\\\a.txt', 'jon'], ['file:///C:/Users/jon/a.txt', 'jon'], ['/c/Users/jon/a.txt', 'jon'],
    ['\\\\fileserver\\share\\jon\\a.txt', 'fileserver'], ['\\\\\\\\fileserver\\\\share\\\\jon\\\\a.txt', 'fileserver'],
    ['C%3A%5CUsers%5Cjon%5Ca.txt', 'jon'], ['C:%5CUsers%5Cjon', 'jon'], ['/home/jon/a.txt', 'jon'], ['/mnt/c/Users/jon/a.txt', 'jon'], ['D:/data/jon.csv', 'jon'],
  ];
  const run = { ...u2!.run, limitations: forms.map(([f]) => `ruta ${f} fin`).concat(['ver https://example.org/docs/page?q=1 y http://host.test/a/c:/x']) };
  const md = renderAgentRunMarkdown(run), html = renderAgentRunHtml(run);
  for (const [form, secret] of forms) for (const out of [md, html]) assert.ok(!out.includes(secret), `leaks ${form}`);
  for (const out of [md, html]) { assert.match(out, /https:\/\/example\.org\/docs\/page\?q=1/); assert.match(out, /http:\/\/host\.test\/a\/c:\/x/); assert.match(out, /\[ruta local\] fin/); }
});

test('RC-5/RC-15/RC-19: scripted offline chooser is neutral; old runs without calls are not FAILED when --no-model or offline; dropped relations are declared in the denominator', () => {
  const base = u2!.run, top = (md: string) => md.slice(0, md.indexOf('## Estado final'));
  const noCalls = { ...base, phases: { ...base.phases, exploration: { ...base.phases.exploration, calls: [], plannerError: undefined } }, modelParticipation: undefined };
  const scripted = top(renderAgentRunMarkdown({ ...noCalls, modelParticipation: 'SCRIPTED_OFFLINE' }, u2!.artifacts));
  assert.match(scripted, /Chooser de script offline, sin modelo/); assert.ok(!scripted.includes('Inconsistencia') && !scripted.includes('NO participo') && !scripted.includes('--no-model'));
  const withCalls = top(renderAgentRunMarkdown({ ...base, modelParticipation: 'SCRIPTED_OFFLINE' }, u2!.artifacts));
  assert.match(withCalls, /Chooser de script offline/); assert.ok(!withCalls.includes('Inconsistencia'));
  assert.match(top(renderAgentRunMarkdown({ ...noCalls, executionMode: 'LIVE', degradations: [{ phase: 'exploration', code: 'NO_MODEL_REQUESTED' }] }, u2!.artifacts)), /El modelo no fue solicitado en este run \(--no-model\)/);
  assert.match(top(renderAgentRunMarkdown({ ...noCalls, executionMode: 'LIVE', modelRequested: false }, u2!.artifacts)), /--no-model/);
  assert.match(top(renderAgentRunMarkdown({ ...noCalls, executionMode: 'LOCAL' }, u2!.artifacts)), /Chooser de script offline/);
  assert.match(top(renderAgentRunMarkdown({ ...noCalls, executionMode: 'LIVE' }, u2!.artifacts)), /El modelo NO participo: sin llamadas/);
  const md = renderAgentRunMarkdown({ ...base, phases: { ...base.phases, discovery: { ...base.phases.discovery, relations: ['a', 'b'] } }, decisions: [{ relationId: 'a', verdict: 'SOSTENIDA' }, { relationId: 'b', verdict: 'INDETERMINADA' }], degradations: [{ phase: 'discovery', code: 'RELATION_DROPPED_TABLE_ABSENT', detail: 'c' }, { phase: 'discovery', code: 'RELATION_DROPPED_TABLE_ABSENT', detail: 'd' }] }, u2!.artifacts);
  assert.match(md, /Cobertura \(decididas \/ relaciones configuradas\)\*\*: 1 de 4/); assert.match(md, /Descartadas por tabla ausente \(RELATION_DROPPED_TABLE_ABSENT\)\*\*: 2 de 4/);
  assert.ok(!md.includes('Sin decision (configuradas'), 'dropped relations are not counted again as undecided');
});

test('M7-6: public benchmark transparency note only when the run carries publicBenchmark and the model participated', () => {
  const base = u2!.run, top = (md: string) => md.slice(0, md.indexOf('## Estado final'));
  const pb = { name: 'TPC-DS', note: 'esquema publico conocido' };
  const used = top(renderAgentRunMarkdown({ ...base, modelParticipation: 'USED', publicBenchmark: pb }, u2!.artifacts));
  assert.match(used, /Universo de benchmark publico \(TPC-DS\): el modelo puede reconocer el esquema por los nombres\. Los veredictos los decide la politica determinista con la evidencia acotada del run; el conocimiento previo del modelo solo puede influir en que acciones elige explorar\./);
  assert.match(used, /Nota del manifiesto: esquema publico conocido/);
  assert.ok(!top(renderAgentRunMarkdown({ ...base, modelParticipation: 'USED' }, u2!.artifacts)).includes('benchmark publico'), 'without the field nothing changes');
  assert.ok(!top(renderAgentRunMarkdown({ ...base, modelParticipation: 'NOT_REQUESTED', publicBenchmark: pb }, u2!.artifacts)).includes('benchmark publico'), 'no note when the model did not participate');
  assert.match(top(renderAgentRunMarkdown({ ...base, publicBenchmark: pb }, u2!.artifacts)), /benchmark publico \(TPC-DS\)/);
});

test('M8-2: reviewQueue renders conflicts and STALE_DEPENDENCY items, with counts by type in the header', () => {
  const base = { schemaVersion: 1, status: 'RECORDED', runId: 'r', universeId: 'U', scope: 's', claims: [], ledger: { entries: 1, appendOnly: true } };
  const conflict = { conflictId: 'cf-1', entity: 'orders', attribute: 'verdict', version: 'v1', claimIds: ['m1', 'm2'], strategy: 'HUMAN' };
  const stale = { kind: 'STALE_DEPENDENCY', claimId: 'm9', entity: 'orders', attribute: 'join_key', causeClaimId: 'm3', reason: 'INVALIDATED', staleAt: '2026-10-25T00:00:00Z' };
  const md = renderAgentRunMarkdown({ ...u2!.run, memory: { ...base, conflicts: [{ id: 'cf-1', state: 'queued' }, { id: 'cf-2', state: 'auto_resolved' }], reviewQueue: [conflict, stale] } });
  assert.match(md, /Cola de revision humana: 2 items: 1 de 2 conflictos esperan decision y 1 dependencias STALE esperan revision\./);
  assert.match(md, /Revision pendiente: orders\.join_key quedo STALE porque m3 fue INVALIDATED/);
  assert.match(md, /\| cf-1 \| orders \| verdict \| v1 \| m1, m2 \| HUMAN \|/); assert.ok(!md.includes('| - | orders | join_key'), 'the stale item is not forced into the conflict table');
  const only = renderAgentRunMarkdown({ ...u2!.run, memory: { ...base, conflicts: [], reviewQueue: [stale] } });
  assert.match(only, /Cola de revision humana: 1 items: 0 de 0 conflictos esperan decision y 1 dependencias STALE/); assert.ok(!only.includes('| Conflicto |'));
});

test('N39: post-COMA shows the policy query estimate against the budget and the priorRun outcome', () => {
  const pc = (extra: object) => ({ status: 'EXECUTED', policy: { maxProbes: 30, ranking: 'x', costPerProbe: 1, equality: 'y', estimatedQueries: 30, queriesAvailable: 12 }, counts: { proposals: 1, executed: 0 }, proposals: [{ proposalId: 'p1', from: { db: 'D', table: 'a', column: 'x' }, to: { db: 'D', table: 'b', column: 'y' }, coverageProbe: { status: 'SKIPPED_BUDGET' } }], ...extra });
  const md = renderAgentRunMarkdown({ ...u2!.run, postComa: pc({ priorRun: { applied: true, skipped: [{ proposalId: 'p7', outcome: 'ACCEPTED' }, { proposalId: 'p8', outcome: 'NEGATIVE' }, { proposalId: 'p9', outcome: 'NEGATIVE' }] } }) }, u2!.artifacts);
  assert.match(md, /consultas estimadas 30 de 12 disponibles en el presupuesto/);
  assert.match(md, /Corrida previa \(priorRun\): aplicada\. 3 propuestas omitidas por resultado previo \(ACCEPTED 1 de 3; NEGATIVE 2 de 3\)\./); assert.match(md, /\| p8 \| NEGATIVE \|/);
  assert.match(renderAgentRunMarkdown({ ...u2!.run, postComa: pc({ priorRun: { applied: false, reason: 'PRIOR_RUN_SCOPE_MISMATCH', skipped: [] } }) }, u2!.artifacts), /priorRun\): no aplicada \(PRIOR_RUN_SCOPE_MISMATCH\); no se omitio ninguna sonda/);
  const none = renderAgentRunMarkdown({ ...u2!.run, postComa: pc({}) }, u2!.artifacts);
  assert.ok(!none.includes('priorRun'), 'no prior run, nothing shown');
  const old = renderAgentRunMarkdown({ ...u2!.run, postComa: { ...pc({}), policy: { maxProbes: 30, ranking: 'x', costPerProbe: 1, equality: 'y' } } }, u2!.artifacts);
  assert.ok(!old.includes('consultas estimadas'), 'old runs without the estimate are unchanged');
});

test('N53: conflict decisionHistory renders every versioned decision; conflicts without history are unchanged', () => {
  const base = { schemaVersion: 1, status: 'RECORDED', runId: 'r', universeId: 'U', scope: 's', claims: [], reviewQueue: [], ledger: { entries: 1, appendOnly: true } };
  const history = [{ version: 1, winner: 'm1', actor: 'legacy-unknown', reason: 'auto', at: 1790000000000 }, { version: 2, winner: 'm2', correction: 'corr-1', actor: 'jonas', reason: 'se verifico en origen', at: 1790086400000 }];
  const md = renderAgentRunMarkdown({ ...u2!.run, memory: { ...base, conflicts: [{ id: 'cf-1', entity: 'orders', attribute: 'verdict', status: 'human_resolved', version: 2, winner: 'm2', decisionHistory: history }, { id: 'cf-2', entity: 'o', attribute: 'a', status: 'queued', version: 1 }] } });
  assert.match(md, /Historial de decisiones: 2 decisiones en 1 de 2 conflictos/);
  assert.match(md, /\| cf-1 \| 1 \| m1 \| - \| legacy-unknown \| auto \| 2026-09-2\dT/); assert.match(md, /\| cf-1 \| 2 \| m2 \| corr-1 \| jonas \| se verifico en origen \|/);
  assert.ok(!renderAgentRunMarkdown({ ...u2!.run, memory: { ...base, conflicts: [{ id: 'cf-2', status: 'queued' }] } }).includes('Historial de decisiones'));
});

test('N58: memory claims are split into written by this run, from previous runs and without origin', () => {
  const base = { schemaVersion: 1, status: 'RECORDED', runId: 'r', universeId: 'U', scope: 's', conflicts: [], reviewQueue: [], ledger: { entries: 1, appendOnly: true } };
  const run = { ...u2!.run, runId: 'run-now', memory: { ...base, claims: [{ id: 'a', firstRunId: 'run-now' }, { id: 'b', firstRunId: 'run-now' }, { id: 'c', firstRunId: 'run-before' }, { id: 'd' }] } };
  assert.match(renderAgentRunMarkdown(run), /Claims por origen: 2 de 4 escritos primero por este run; 1 de 4 de runs previos; 1 de 4 sin firstRunId \(origen no registrado\)\./);
  assert.ok(!renderAgentRunMarkdown({ ...run, memory: { ...base, claims: [] } }).includes('Claims por origen'));
});
