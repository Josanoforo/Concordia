import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { runAgent } from '../src/agent/engine.ts';
import { compactProposals, compactProposalsView, runExploration, COMPACT_PROPOSALS_SHOWN, COMPACT_PROPOSALS_THRESHOLD, MAX_COLUMNS_IN_PROMPT } from '../src/agent/exploration.ts';
import { catalogOf } from '../src/agent/catalog.ts';
import { GENERIC_CODE_PREFIX, NightshiftChooser, type ActionChooser, type ChoiceCall } from '../src/agent/chooser.ts';
import { limitsFromBounds, RunBudget } from '../src/agent/run-budget.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

const proposal = (table: string, column: string, toTable: string, toColumn: string, rawScore: number) => ({ from: { table, column }, to: { table: toTable, column: toColumn }, rawScore, reason: 'x', inputHash: 'h'.repeat(64) });
const legacy = (items: any[]) => items.map(i => ({ from: `${i.from.table}.${i.from.column}`, to: `${i.to.table}.${i.to.column}`, score: Math.round(i.rawScore * 100) / 100 }));
const wide = (n: number) => Array.from({ length: n }, (_, i) => proposal(`t${i % 24}`, `c${i % 7}`, `t${(i * 5 + 1) % 24}`, `d${i % 11}`, ((i * 37) % 100) / 100));

test('C5: up to the threshold the proposals are exactly what they were (narrow universes keep a byte-identical observation)', () => {
  for (const n of [0, 1, 8, COMPACT_PROPOSALS_THRESHOLD]) {
    const items = wide(n), view = compactProposalsView(items);
    assert.equal(JSON.stringify(view.list), JSON.stringify(legacy(items)));
    assert.equal(view.summary, undefined);
    assert.equal(JSON.stringify(compactProposals(items)), JSON.stringify(legacy(items)));
  }
  assert.deepEqual(compactProposals(undefined), []);
});

test('C5: a wide universe keeps the most relevant 25, says how many were omitted, and is deterministic', () => {
  const items = wide(1410), relevant = new Set(['t3']), view = compactProposalsView(items, relevant);
  assert.equal(view.list.length, COMPACT_PROPOSALS_SHOWN);
  assert.deepEqual([view.summary!.total, view.summary!.shown, view.summary!.omitted], [1410, 25, 1385]);
  assert.match(view.summary!.note, /25 of 1410.*1385 omitted/);
  assert.equal(view.summary!.topTables.length, 10);
  const touching = (item: any) => /^t3\./.test(item.from) || /^t3\./.test(item.to);
  assert.ok((view.list as any[]).filter(touching).length === Math.min(25, items.filter(i => i.from.table === 't3' || i.to.table === 't3').length), 'catalog-table proposals come first');
  assert.equal(JSON.stringify(compactProposalsView([...items].reverse(), relevant)), JSON.stringify(view), 'stable regardless of input order');
});

test('C5: the estimate of a 24-table observation drops from ~60k to far under 25k', () => {
  const cfg = universeConfig('AGENTFX'), catalog = catalogOf(cfg)!, chooser: any = new NightshiftChooser({} as any, 'agent-c5', catalog, GENERIC_CODE_PREFIX);
  const allowed = ['STOP_EXPLORATION', ...catalog.actions.map(a => a.id)], base = { scope: cfg.scope, samples: {}, completedActions: [] }, items = wide(1410);
  const before = chooser.estimateTokens('s', { ...base, comaOutOfScopeProposals: legacy(items) }, allowed, {});
  const view = compactProposalsView(items), after = chooser.estimateTokens('s', { ...base, comaOutOfScopeProposals: view.list, comaOutOfScopeSummary: view.summary }, allowed, {});
  assert.ok(before > 25000, `before ${before}`);
  assert.ok(after < before / 10 && after < 8000, `after ${after}`);
});

class Spy implements ActionChooser {
  seen: any[] = [];
  async choose(stage: string, observation: unknown): Promise<ChoiceCall> {
    this.seen.push(observation);
    return { stage, status: 'PASS', decisionStatus: 'VALID', requestedModel: 'spy', selected: 'STOP_EXPLORATION', reason: 'stop', promptHash: 'h', utc: '2026-10-26T00:00:00.000Z' };
  }
}
const explore = (proposals: unknown, mutate?: (discovery: any) => void) => {
  const cfg = universeConfig('AGENTFX'), fixture = structuredClone(agentFixtures().find(i => i.alias === 'AGENTFX')!), spy = new Spy();
  return runAgent('AGENTFX', 'agent-c5-run', { client: fixtureClient(cfg, fixture.tables) as any, chooser: spy, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false,
    comaBridge: (input: any) => ({ schemaVersion: 1, provider: 'valentine.Coma', version: '1.1.0', configuration: { max_n: 0, use_instances: false, use_schema: true, delta: 0.15, threshold: 0, instance_weight: 1 },
      matches: input.pairs.map((pair: any) => ({ source: pair.source, target: pair.target, matches: [{ sourceColumn: pair.allowed[0].sourceColumn, targetColumn: pair.allowed[0].targetColumn, rawScore: 0.9 }] })) }) }).then((report: any) => ({ report, spy }));
};

test('C5: a narrow universe run shows no summary and records no compaction', async () => {
  const { report, spy } = await explore(undefined);
  assert.ok(spy.seen.length >= 1);
  assert.equal('comaOutOfScopeSummary' in spy.seen[0], false);
  assert.equal('observationCompacted' in report.phases.exploration, false);
});

test('C5: tables with more than 30 shown columns are capped, the cut is in the observation and in the exploration record', async () => {
  const cfg = universeConfig('AGENTFX'), catalog = catalogOf(cfg)!, spy = new Spy();
  const columns = Array.from({ length: 45 }, (_, i) => `col_${i}`), table = catalog.actions[0]!.table;
  const discovery = { tables: { [table]: { columns, sample: { queryId: 'q', rows: [columns.map((_, i) => i)] } } } };
  const result = await runExploration({ runId: 'agent-c5-cols', cfg, catalog, discovery, sourceColumns: {}, client: { runSql: async () => { throw new Error('no'); } } as any, chooser: spy,
    budget: new RunBudget(limitsFromBounds()), extraObservation: wide(100), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' });
  const shown = spy.seen[0].samples[table];
  assert.equal(shown.columns.length, MAX_COLUMNS_IN_PROMPT);
  assert.equal(shown.columnsOmitted, 15);
  assert.deepEqual(result.observationCompacted?.sampleColumns?.[table], { total: 45, shown: 30, omitted: 15 });
  assert.deepEqual(result.observationCompacted?.proposals, { total: 100, shown: 25, omitted: 75 });
  assert.equal(spy.seen[0].comaOutOfScopeSummary.omitted, 75);
});
