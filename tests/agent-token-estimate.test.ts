import test from 'node:test';
import assert from 'node:assert/strict';
import { NightshiftChooser, type ActionChooser, type ChoiceCall } from '../src/agent/chooser.ts';
import { compactProposals, runExploration } from '../src/agent/exploration.ts';
import { selectProbes } from '../src/agent/probe-selector.ts';
import { estimateCallTokens, limitsFromBounds, RunBudget } from '../src/agent/run-budget.ts';
import { catalogOf } from '../src/agent/catalog.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

class CostlyChooser implements ActionChooser {
  calls = 0;
  constructor(private readonly cost: number) {}
  estimateTokens() { return this.cost; }
  async choose(stage: string): Promise<ChoiceCall> { this.calls++; throw new Error(`model must not be called: ${stage}`); }
}

test('budget: used + estimated above the cap blocks the call and records the cause', () => {
  const budget = new RunBudget(limitsFromBounds({ maxTokensPerRun: 1000 })); budget.chargeTokens(400);
  assert.equal(budget.canAfford(600), true);
  assert.equal(budget.canAfford(601), false);
  assert.deepEqual(budget.wouldExceed(601), { code: 'TOKEN_BUDGET_WOULD_EXCEED', used: 400, estimated: 601, limit: 1000 });
  assert.equal(estimateCallTokens([{ content: 'x'.repeat(300) }, { content: 'y'.repeat(100) }], 50), 200 + 50, 'chars/2 plus the output allowance');
});

test('exploration: an estimate above the remaining tokens makes no model call and leaves the cause in the run report', async () => {
  const chooser = new CostlyChooser(14000);
  const budget = new RunBudget(limitsFromBounds()); budget.chargeTokens(2000);
  const cfg = universeConfig('AGENTFX');
  const stopped = await runExploration({ runId: 'agent-x', cfg, catalog: catalogOf(cfg)!, discovery: { tables: {} }, sourceColumns: {}, client: { runSql: async () => { throw new Error('no sql'); } } as any, chooser, budget, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' });
  assert.equal(chooser.calls, 0);
  assert.deepEqual(stopped.plannerError, { code: 'TOKEN_BUDGET_WOULD_EXCEED', used: 2000, estimated: 14000, limit: 15000 });
  assert.equal(budget.steps, 0, 'no exploration step is consumed');
  assert.equal(stopped.calls.length, 0);
});

test('probe ranking: an estimate above the remaining tokens falls back to config order with the explicit cause', async () => {
  const chooser = new CostlyChooser(14000), budget = new RunBudget(limitsFromBounds()); budget.chargeTokens(5000);
  const selection = await selectProbes({ relations: [{ id: 'a' }, { id: 'b' }], budget, chooser });
  assert.equal(chooser.calls, 0);
  assert.deepEqual(selection.fallback, { reason: 'TOKEN_BUDGET_WOULD_EXCEED', used: 5000, estimated: 14000, limit: 15000 });
  assert.deepEqual(selection.selected, ['a', 'b']);
  assert.equal(selection.mode, 'CHOSEN_WITH_FALLBACK');
});

test('U1 exploration prompt: catalog tables only, at most 3 sample rows, no sensitive columns, compact COMA proposals', async () => {
  const cfg = universeConfig('U1'), catalog = catalogOf(cfg)!;
  const columns = ['LocationID', 'zone_id', 'pickup_zone_id', 'PULocationID', 'borough', 'pickup_city', 'rider_email', 'fare', 'zone'];
  const rows = Array.from({ length: 20 }, (_, i) => columns.map(c => `${c}-${i}-0a5842c9-a102-4873-84d1-f2e73b9cd8b2`));
  const tables = Object.fromEntries(Object.keys(cfg.tables).map(name => [name, { columns, sample: { queryId: `q-${name}`, rows } }]));
  const proposals = Array.from({ length: 9 }, (_, i) => ({ providerId: 'valentine.coma', providerVersion: '1.1.0', from: { db: 'NY_TAXI', table: 'yellow_taxi', column: 'PULocationID' }, to: { db: 'NY_TAXI', table: 'taxi_zones', column: 'LocationID' },
    rawScore: 0.888888 - i / 100, reason: 'COMA_COLUMN_PAIR_OUT_OF_SCOPE', inputHash: 'a'.repeat(64), configHash: 'b'.repeat(64), evidenceRefs: Array.from({ length: 8 }, () => '0a5842c9-a102-4873-84d1-f2e73b9cd8b2') }));
  let seen: any;
  const chooser = new NightshiftChooser({ route: 'r', chat: async () => { throw new Error('not called'); } } as any, 'agent-x', catalog);
  const recording: ActionChooser = { estimateTokens: (stage, obs, allowed, o) => { seen = obs; return chooser.estimateTokens(stage, obs, allowed, o); }, choose: async () => { throw new Error('no'); } };
  const budget = new RunBudget(limitsFromBounds({ maxTokensPerRun: 10 }));
  await runExploration({ runId: 'agent-x', cfg, catalog, discovery: { tables }, sourceColumns: {}, client: {} as any, chooser: recording, budget, extraObservation: proposals, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' });
  const wanted = new Set([...catalog.actions.map(a => a.table), ...Object.values(catalog.observations).map(o => o.fromTable)]);
  assert.deepEqual(Object.keys(seen.samples).sort(), [...wanted].sort(), 'only tables the catalog uses');
  assert.ok(wanted.size < Object.keys(cfg.tables).length);
  for (const sample of Object.values<any>(seen.samples)) {
    assert.ok(sample.rows.length <= 3);
    assert.equal(JSON.stringify(sample).match(/city|email/i), null, 'sensitive columns are removed');
  }
  assert.deepEqual(seen.comaOutOfScopeProposals[0], { from: 'yellow_taxi.PULocationID', to: 'taxi_zones.LocationID', score: 0.89 });
  const oldObservation = { ...seen, samples: Object.fromEntries([...wanted].map(t => [t, { columns, rows: rows.slice(0, 10).map(r => Object.fromEntries(columns.map((c, i) => [c, r[i]]))) }])), comaOutOfScopeProposals: proposals };
  const before = chooser.estimateTokens('s', oldObservation, ['A', 'STOP_EXPLORATION']), after = chooser.estimateTokens('s', seen, ['A', 'STOP_EXPLORATION']);
  assert.ok(after < before / 2, `prompt shrinks (${before} -> ${after})`);
  assert.deepEqual(compactProposals(undefined), []);
});
