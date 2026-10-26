import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/runtime.ts';
import { renderAgentRunMarkdown, renderAgentRunHtml } from '../src/report/agent-run-report.ts';

// Sanitized reduction of the real wide-universe LIVE run agent-tpcds-live-04 (deterministic ids, arrays cut to 104 post-COMA proposals / 60 COMA proposals; counts match the cut).
const dir = path.join(ROOT, 'tests', 'fixtures', 'agent-runs', 'agent-tpcds-live-04');
const run = JSON.parse(fs.readFileSync(path.join(dir, 'engine-run.json'), 'utf8')), artifacts = JSON.parse(fs.readFileSync(path.join(dir, 'artifacts.json'), 'utf8'));
const md = renderAgentRunMarkdown(run, artifacts), html = renderAgentRunHtml(run, artifacts);

test('live-04 fixture: LIVE label, public benchmark note, degradations and denominators', () => {
  assert.match(md, /\*\*LIVE\*\* \| origen de datos: \*\*PUBLIC\*\*/);
  assert.match(md, /Universo de benchmark publico \(TPC-DS\)/); assert.match(md, /Degradaciones: 2\./);
  assert.match(md, /\| critic \| CRITIC_SKIPPED \| no probe results \|/);
  assert.match(md, /Tokens por decision del modelo\*\*: 5234 \(15703 tokens de 3 llamadas con recibo, entre 3 decisiones validas con recibo; 3 llamadas en total\)/);
  assert.match(md, /suma de recibos, el contador del presupuesto registra 24693/);
});

test('live-04 fixture: wide sections stay bounded and consistent', () => {
  assert.ok(md.split('\n').length < 400, `report is ${md.split('\n').length} lines`);
  assert.match(md, /Se listan las 20 de mayor puntaje crudo de 60 propuestas fuera de alcance/);
  assert.match(md, /Universo ancho: 104 propuestas\. Sugeridas sin sonda por el tope de sondas: 40 de 104; no ejecutables: 34 de 104; omitidas por presupuesto de consultas \(SKIPPED_BUDGET\): 0 de 104\./);
  assert.match(md, /No ejecutadas por presupuesto: 40\. Ejecutadas 30 de 104 propuestas\. Razones: NOT_SELECTED_MAX_PROBES 40 de 40\. Se listan las 20 primeras/);
  assert.equal((md.match(/\| NOT_SELECTED_MAX_PROBES \|/g) ?? []).length, 20);
  assert.match(md, /30 candidatas descubiertas por el post-COMA ciego/); assert.match(md, /HIGH: 17 de 17 valores; umbral 0\.8/);
  assert.match(md, /Sin veredictos\./); assert.match(md, /Sin decisiones: no hay cobertura que calcular\./);
  assert.match(md, /Ranking de sondas por modelo\*\*: NOT_APPLICABLE_NO_CONFIGURED_PROBES/);
});

test('live-04 fixture: nothing real leaks into either rendering', () => {
  for (const out of [md, html]) {
    assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/.test(out), 'no UUIDs');
    assert.ok(!/[A-Za-z]:[\\/]/.test(out) && !/\/(Users|home)\//.test(out), 'no local paths');
  }
});

test('A40: catalog_page.cp_catalog_page_sk repeated keys are reported as a data-quality finding with denominators', () => {
  assert.match(md, /## Hallazgos de calidad de datos/);
  assert.match(md, /Columnas destino con claves repetidas en la muestra acotada: 1\..*observado en 2 de 30 sondas ejecutadas/);
  assert.match(md, /\| catalog_page\.cp_catalog_page_sk \| 2 \| 2 \| 20 \| 2 \| catalog_returns\.cr_catalog_page_sk, catalog_sales\.cs_catalog_page_sk \|/);
  assert.match(md, /no una refutacion de las relaciones que las apuntan/);
  assert.ok(!renderAgentRunMarkdown({ ...run, postComa: { ...run.postComa, proposals: run.postComa.proposals.filter((p: any) => !/catalog_page_sk__catalog_page/.test(p.proposalId)) } }, artifacts).includes('Hallazgos de calidad de datos'), 'absent when no duplicates');
});
