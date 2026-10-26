import test from 'node:test';
import assert from 'node:assert/strict';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { runExploration } from '../src/agent/exploration.ts';
import { limitsFromBounds, RunBudget } from '../src/agent/run-budget.ts';
import { catalogOf } from '../src/agent/catalog.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

class Silent implements ActionChooser {
  async choose(stage: string): Promise<ChoiceCall> { return { stage, status: 'PASS', decisionStatus: 'INVALID_RESPONSE', requestedModel: 'scripted', promptHash: 'x', utc: '2026-10-25T00:00:00.000Z' }; }
}

test('N52: the generic loop names a missing decision MODEL_DECISION_UNAVAILABLE, not a U2 code', async () => {
  const cfg = universeConfig('AGENTFX');
  const result = await runExploration({ runId: 'agent-x', cfg, catalog: catalogOf(cfg)!, discovery: { tables: {} }, sourceColumns: {}, client: { runSql: async () => { throw new Error('no sql'); } } as any,
    chooser: new Silent(), budget: new RunBudget(limitsFromBounds()), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' });
  assert.deepEqual(result.plannerError, { code: 'MODEL_DECISION_UNAVAILABLE' });
});
