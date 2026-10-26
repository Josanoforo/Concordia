import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import type { ComaBridge, ComaSchemaInput } from '../src/discovery/coma-provider.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { renderAgentRunMarkdown } from '../src/report/agent-run-report.ts';

/** N55: the report of a real blind post-COMA run over the offline TPCDS fixture (the 5-table fixture of agent-tpcds-e2e), not a synthetic postComa. */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const targetedBridge = (wanted: [string, string, string, string, number][]): ComaBridge => (input: ComaSchemaInput) => ({ schemaVersion: 1, provider: 'valentine.Coma', version: '1.1.0', matches: input.pairs.flatMap(pair => {
  const matches = wanted.filter(([ta, , tb]) => ta === pair.source && tb === pair.target).map(([, a, , b, score]) => ({ sourceColumn: a, targetColumn: b, rawScore: score }));
  return matches.length ? [{ source: pair.source, target: pair.target, matches }] : [];
}) });

test('N55: a real blind run renders the cap line, ordered candidates (clean HIGH first), the not-executed table and no verdicts', async () => {
  const fixture = agentFixtures().find(item => item.alias === 'TPCDS')!, cfg = universeConfig('TPCDS');
  const bridge = targetedBridge([['catalog_sales', 'cs_sold_date_sk', 'date_dim', 'd_date_sk', 0.99], ['catalog_returns', 'cr_reason_sk', 'reason', 'r_reason_sk', 0.98],
    ['call_center', 'cc_call_center_sk', 'ship_mode', 'sm_ship_mode_sk', 0.9], ['customer', 'c_customer_sk', 'item', 'i_item_sk', 0.86]]);
  const run: any = await runAgent('TPCDS', 'agent-n55-blind', { client: fixtureClient(cfg, fixture.tables) as any, chooser: new Script([...fixture.chooserScript]), comaBridge: bridge, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false } as any);
  const md = renderAgentRunMarkdown(run, run.artifacts);
  assert.match(md, /Busqueda ciega: \d+ de \d+ pares de tablas comparados/);
  assert.match(md, /## Candidatas descubiertas \(requieren revision\)/); assert.match(md, /candidata, no veredicto: CANDIDATE_REQUIRES_REVIEW\. \d+ candidatas descubiertas por el post-COMA ciego/);
  const section = md.slice(md.indexOf('## Candidatas descubiertas'), md.indexOf('\n## ', md.indexOf('## Candidatas descubiertas') + 5));
  const rows = section.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| Par') && !l.startsWith('| ---'));
  assert.ok(rows.length >= 3, 'the executed probes appear as candidates');
  const firstClean = rows.findIndex(r => /\| HIGH: /.test(r) && /\| no \|/.test(r)), firstSuspect = rows.findIndex(r => /\| si: /.test(r));
  assert.ok(firstClean === 0, 'a clean HIGH candidate comes first'); assert.ok(firstSuspect === -1 || firstSuspect > firstClean);
  assert.match(md, /Sin veredictos\./); assert.match(md, /Sin decisiones: no hay cobertura que calcular\./);
  assert.ok(run.postComa.proposals.every((p: any) => p.verificationStatus === 'NO VERIFICADO/UNKNOWN' && p.reviewState === 'PENDING'));
});

test('N55: the blind cap line says when the search was capped and not exhaustive; configured-relations runs have no such line', async () => {
  const base: any = { runId: 'r', universeId: 'U', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', status: 'COMPLETED', phases: { coma: { status: 'RAN', outOfScopeProposals: [] } } };
  const capped = renderAgentRunMarkdown({ ...base, phases: { coma: { ...base.phases.coma, blind: { pairs: 100, tablePairs: 276, cap: 100, capped: true, order: 'table name' } } } });
  assert.match(capped, /Busqueda ciega: 100 de 276 pares de tablas comparados; la busqueda esta limitada por el tope de 100 pares y NO es exhaustiva; orden: table name\./);
  const full = renderAgentRunMarkdown({ ...base, phases: { coma: { ...base.phases.coma, blind: { pairs: 10, tablePairs: 10, cap: 100, capped: false } } } });
  assert.match(full, /Busqueda ciega: 10 de 10 pares de tablas comparados; el tope no limito la busqueda\./);
  assert.ok(!renderAgentRunMarkdown(base).includes('Busqueda ciega'));
});
