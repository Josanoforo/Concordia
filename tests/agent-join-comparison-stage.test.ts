import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareAgentContext, runAgent, runDiscoveryPhase, runJoinComparisonStage } from '../src/agent/engine.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

const fixture = () => structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!);
const client = () => fixtureClient(universeConfig('AGENTFX'), fixture().tables) as any;
const alternatives = [{ choice: 'CUSTOMER_ID', source: { table: 'orders', columns: ['customer_id'] }, target: { table: 'customers', columns: ['customer_id'] }, normalization: ['text'] }];
const stage = async (withSpecs: boolean, spendAll = false) => {
  const ctx = prepareAgentContext('AGENTFX', 'agent-join-stage', { client: client(), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false });
  const phase = await runDiscoveryPhase(ctx);
  if (withSpecs) (ctx.catalog as any) = { ...ctx.catalog, joinAlternatives: alternatives };
  if (spendAll) while (ctx.budget.canQuery()) ctx.budget.chargeQuery();
  return runJoinComparisonStage(ctx, phase, { calls: [], actions: [], reads: {} } as any);
};

test('declared joinAlternatives are measured over observed rows with no extra SQL', async () => {
  const result: any = await stage(true);
  assert.equal(result.status, 'COMPARED');
  assert.equal(result.queriesCharged, 0);
  assert.deepEqual(result.alternatives.map((item: any) => item.choice), ['CUSTOMER_ID', 'NO_JOIN']);
  assert.equal(result.alternatives[0].fieldAvailability, 'AVAILABLE');
});

test('an exhausted SQL budget records the comparison as not executed', async () => {
  const result: any = await stage(true, true);
  assert.equal(result.status, 'NOT_EXECUTED_BUDGET');
  assert.deepEqual(result.alternatives, []);
});

test('without joinAlternatives nothing changes: no stage result and no phases.joinComparison', async () => {
  assert.equal(await stage(false), undefined);
  const report: any = await runAgent('AGENTFX', 'agent-join-none', { client: client(), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false });
  assert.equal('joinComparison' in report.phases, false);
});
