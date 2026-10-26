import test from 'node:test';
import { resolveUniverseManifest, validateUniverseRegistry } from '../src/registry/universes.ts';
import assert from 'node:assert/strict';
import { DEFAULT_PHASE_SHARES, limitsFromBounds, RUN_BUDGET_CEILINGS, RunBudget } from '../src/agent/run-budget.ts';

/** P7: ceilings that fit a full run, declared per universe; and a pre-estimation that reports the cost of covering N units before running anything. */
test('P7 ceilings: a universe can declare a full-run budget up to the ceilings; beyond them, or non-integers, are refused; defaults are unchanged', () => {
  assert.deepEqual(limitsFromBounds(), { maxQueriesPerRun: 25, readLimit: 50, maxTokensPerRun: 15000, maxSteps: 3 });
  const full = { maxQueriesPerRun: 1500, maxTokensPerRun: 1_500_000, maxSteps: 40 };
  assert.deepEqual(limitsFromBounds(full), { ...limitsFromBounds(), ...full });
  assert.doesNotThrow(() => limitsFromBounds({ ...RUN_BUDGET_CEILINGS }));
  for (const key of Object.keys(RUN_BUDGET_CEILINGS) as (keyof typeof RUN_BUDGET_CEILINGS)[])
    assert.throws(() => limitsFromBounds({ [key]: RUN_BUDGET_CEILINGS[key] + 1 }), /RUN_BUDGET_INVALID/, key);
  assert.throws(() => limitsFromBounds({ maxQueriesPerRun: 1.5 }), /RUN_BUDGET_INVALID/);
  assert.deepEqual([RUN_BUDGET_CEILINGS.maxQueriesPerRun, RUN_BUDGET_CEILINGS.maxTokensPerRun], [5000, 4_000_000]);
  // a full blind run (coverAll over ~1400 candidates is about 3600 queries) fits; one past the ceiling does not
  assert.equal(limitsFromBounds({ maxQueriesPerRun: 3600 }).maxQueriesPerRun, 3600);
  assert.equal(limitsFromBounds({ maxQueriesPerRun: 5000 }).maxQueriesPerRun, 5000);
  assert.throws(() => limitsFromBounds({ maxQueriesPerRun: 5001 }), /RUN_BUDGET_INVALID/);
  // the primary model review pre-estimates about 2.84M tokens: it fits the 4M ceiling, one past it does not
  assert.equal(limitsFromBounds({ maxTokensPerRun: 2_840_000 }).maxTokensPerRun, 2_840_000);
  assert.throws(() => limitsFromBounds({ maxTokensPerRun: 4_000_001 }), /RUN_BUDGET_INVALID/);
});

test('P7 estimate: reports estimated cost, what is available, the shortfall and how many units are affordable; charges nothing', () => {
  const budget = new RunBudget(limitsFromBounds({ maxQueriesPerRun: 100, maxTokensPerRun: 20000 }));
  for (let i = 0; i < 10; i++) budget.chargeQuery();
  budget.chargeTokens(5000);
  const before = JSON.stringify(budget.snapshot().used);
  const fits = budget.estimate(80, { queries: 1 });
  assert.deepEqual([fits.estimatedQueries, fits.queriesAvailable, fits.fits, fits.queryShortfall, fits.affordableUnits], [80, 90, true, 0, 80]);
  const tight = budget.estimate(276, { queries: 1 });
  assert.deepEqual([tight.fits, tight.fitsQueries, tight.queryShortfall, tight.affordableUnits], [false, false, 186, 90]);
  const tokens = budget.estimate(30, { queries: 1, tokens: 1000 });
  assert.deepEqual([tokens.estimatedTokens, tokens.tokensAvailable, tokens.fitsTokens, tokens.tokenShortfall, tokens.affordableUnits], [30000, 15000, false, 15000, 15]);
  assert.equal(JSON.stringify(budget.snapshot().used), before, 'estimating never charges');
  assert.equal(budget.estimate(0).fits, true);
  assert.equal(budget.estimate(5, {}).affordableUnits, 5, 'free units are all affordable');
  assert.throws(() => budget.estimate(-1), /COST_ESTIMATE_INVALID/);
  assert.throws(() => budget.estimate(1, { queries: -1 }), /COST_ESTIMATE_INVALID/);
});

test('P7 estimate follows the phase allowance when phase shares are on', () => {
  const budget = new RunBudget(limitsFromBounds({ maxQueriesPerRun: 100, maxTokensPerRun: 10000 }), DEFAULT_PHASE_SHARES);
  budget.enterPhase('discovery');
  assert.equal(budget.estimate(1, { queries: 1 }).queriesAvailable, 40);
  budget.enterPhase('postComa');
  assert.equal(budget.estimate(1, { queries: 1 }).queriesAvailable, 100, 'post-COMA runs on whatever the global ceiling has left');
  assert.equal(budget.estimate(1, { queries: 1 }).phase, 'postComa');
});

test('P7 registry: a universe manifest may declare 3600 queries and is rejected at 5001', () => {
  const manifest = (queries: number) => { const copy: any = structuredClone(resolveUniverseManifest('NWCH')!); copy.capabilityBounds.AGENT_EXPLORATION.maxQueriesPerRun = queries; return copy; };
  const issues = (queries: number) => validateUniverseRegistry([manifest(queries) as any]).filter(issue => /maxQueriesPerRun/.test(issue.path));
  assert.deepEqual(issues(3600), []);
  assert.ok(issues(5001).length > 0);
});
