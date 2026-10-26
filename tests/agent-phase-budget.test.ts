import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { runAgent } from '../src/agent/engine.ts';
import { DEFAULT_PHASE_SHARES, limitsFromBounds, RunBudget } from '../src/agent/run-budget.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

const limits = limitsFromBounds({ maxQueriesPerRun: 20, maxTokensPerRun: 10000 });
const SHARES = { discovery: 0.4, exploration: 0.2, probes: 0.3, critic: 0.1 };

test('R5-3: a phase stops cleanly at its allowance with PHASE_BUDGET_EXHAUSTED while the global ceiling is untouched', () => {
  const budget = new RunBudget(limits, SHARES);
  budget.enterPhase('discovery');
  for (let i = 0; i < 8; i++) budget.chargeQuery();
  assert.equal(budget.canQuery(), false);
  assert.throws(() => budget.chargeQuery(), /PHASE_BUDGET_EXHAUSTED/);
  assert.equal(budget.queries, 8);
  budget.enterPhase('exploration');
  assert.equal(budget.canQuery(), true, 'the next phase has its own allowance');
});

test('R5-3: what a phase does not use passes to the next one, and the snapshot records allocated, transferred and used', () => {
  const budget = new RunBudget(limits, SHARES);
  budget.enterPhase('discovery'); for (let i = 0; i < 3; i++) budget.chargeQuery(); budget.chargeTokens(1000);
  budget.enterPhase('exploration');
  for (let i = 0; i < 4 + 5; i++) budget.chargeQuery(); // 4 allocated + 5 carried over from discovery
  assert.equal(budget.canQuery(), false);
  const snapshot: any = budget.snapshot().phases;
  assert.equal(snapshot.enabled, true);
  assert.deepEqual(snapshot.byPhase.discovery.allocated, { queries: 8, tokens: 4000 });
  assert.deepEqual(snapshot.byPhase.exploration.allocated, { queries: 4, tokens: 2000 });
  assert.deepEqual(snapshot.byPhase.exploration.transferredIn, { queries: 5, tokens: 3000 });
  assert.deepEqual(snapshot.byPhase.exploration.used, { queries: 9, tokens: 0 });
  budget.enterPhase('probes'); budget.enterPhase('critic'); budget.enterPhase('postComa');
  assert.equal(budget.canQuery(), true, 'post-COMA is not shared: it uses what the global ceiling has left');
});

test('R5-3: token allowance is per phase too; invalid shares are rejected; without shares nothing is cut', () => {
  const budget = new RunBudget(limits, SHARES);
  budget.enterPhase('exploration'); // cumulative 60 % of 10000, none used before
  budget.chargeTokens(5900);
  assert.equal(budget.canAfford(200), false);
  assert.equal((budget.wouldExceed(200) as any).code, 'PHASE_BUDGET_EXHAUSTED');
  assert.throws(() => new RunBudget(limits, { ...SHARES, critic: 0.5 }), /PHASE_SHARES_INVALID/);
  const open = new RunBudget(limits);
  for (let i = 0; i < 20; i++) open.chargeQuery();
  assert.throws(() => open.chargeQuery(), /AGENT_QUERY_BUDGET_EXCEEDED/);
  assert.equal(open.snapshot().phases.enabled, false);
  assert.equal(open.snapshot().phases.byPhase.discovery.used.queries, 20, 'usage is observed even when the split is off');
});

test('R5-3 engine: with phaseBudget the run records budget.phases and the per-phase usage adds up to the gated queries', async () => {
  const fx = structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!);
  const run = (id: string, phaseBudget?: boolean) => runAgent('AGENTFX', id, { client: fixtureClient(universeConfig('AGENTFX'), fx.tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false, phaseBudget }) as Promise<any>;
  const plain = await run('agent-phase-off'), split = await run('agent-phase-on', true);
  assert.equal(plain.budget.phases.enabled, false);
  assert.equal(split.budget.phases.enabled, true);
  assert.deepEqual(split.budget.phases.shares, DEFAULT_PHASE_SHARES);
  const sum = Object.values<any>(split.budget.phases.byPhase).reduce((total, phase) => total + phase.used.queries, 0);
  assert.equal(sum, split.budget.used.queries);
  assert.ok(split.budget.phases.byPhase.discovery.used.queries > 0 && split.budget.phases.byPhase.probes.used.queries > 0);
  assert.equal(plain.budget.used.queries, split.budget.used.queries, 'on AGENTFX the default split cuts nothing, so the verdicts are the same');
  assert.deepEqual(plain.decisions, split.decisions);
});
