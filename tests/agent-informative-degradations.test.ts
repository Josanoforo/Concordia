import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** RC-22: informational degradations are produced and listed, and they never change a COMPLETED status. */
class Elector implements ActionChooser {
  constructor(private readonly script: string[], private readonly tokens = 10) {}
  private step = 0;
  estimateTokens() { return 10; }
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const selected = this.script[Math.min(this.step++, this.script.length - 1)]!;
    return { stage, status: 'PASS', decisionStatus: allowed.includes(selected) ? 'VALID' : 'INVALID', requestedModel: 'scripted', selected, reason: 'scripted', promptHash: 'h', utc: '2026-10-26T00:00:00.000Z', receipt: { totalTokens: this.tokens } as any };
  }
}
const run = (extra: Record<string, unknown> = {}) => {
  const cfg = universeConfig('AGENTFX'), fixture = structuredClone(agentFixtures().find(i => i.alias === 'AGENTFX')!);
  return runAgent('AGENTFX', 'agent-info-deg', { client: fixtureClient(cfg, fixture.tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false, ...extra }) as Promise<any>;
};
const codes = (report: any) => report.degradations.map((d: any) => `${d.phase}:${d.code}`);

test('RC-22 NO_MODEL_REQUESTED: a LIVE run started with --no-model lists it and stays COMPLETED', async () => {
  const report = await run({ executionMode: 'LIVE', modelRequested: false });
  assert.ok(codes(report).includes('exploration:NO_MODEL_REQUESTED'), codes(report).join());
  assert.deepEqual([report.modelParticipation, report.status], ['NOT_REQUESTED', 'COMPLETED']);
  const local = await run({ modelRequested: false });
  assert.equal(codes(local).includes('exploration:NO_MODEL_REQUESTED'), false, 'only a LIVE run records it');
});

test('RC-22 BUDGET_EXHAUSTED_STEPS: the exploration uses every step and the run stays COMPLETED', async () => {
  const report = await run({ chooser: new Elector(['READ_CUSTOMER_PROFILE', 'READ_REGION_REFERENCE', 'STOP_EXPLORATION']) });
  assert.ok(report.budget.exhausted.includes('steps'), JSON.stringify(report.budget.exhausted));
  assert.ok(codes(report).includes('budget:BUDGET_EXHAUSTED_STEPS'), codes(report).join());
  assert.equal(report.status, 'COMPLETED');
});

test('RC-22 BUDGET_EXHAUSTED_TOKENS: a model that spends the whole token budget lists it and the run stays COMPLETED', async () => {
  const report = await run({ chooser: new Elector(['READ_CUSTOMER_PROFILE', 'READ_REGION_REFERENCE', 'STOP_EXPLORATION'], 20_000) });
  assert.ok(report.budget.exhausted.includes('tokens'), JSON.stringify(report.budget.exhausted));
  assert.ok(codes(report).includes('budget:BUDGET_EXHAUSTED_TOKENS'), codes(report).join());
  assert.equal(report.status, 'COMPLETED');
});
