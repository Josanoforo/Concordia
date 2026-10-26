import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { prepareAgentContext, runDiscoveryPhase } from '../src/agent/engine.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

const context = (alias: string) => prepareAgentContext(alias, `agent-s5-${alias.toLowerCase()}`, { client: fixtureClient(universeConfig(alias), structuredClone(agentFixtures().find(i => i.alias === alias)!).tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false });
const replay = (tables: string[]) => ({ tables: Object.fromEntries(tables.map(name => [name, { columns: [], sample: { rows: [] } }])) });

test('S5: relations whose endpoint table was not discovered are dropped and named; the rest are kept', async () => {
  const ctx = context('AGENTFX'), all = ctx.cfg.relations.map((r: any) => r.id);
  const full = await runDiscoveryPhase(ctx, replay(['orders', 'customers', 'regions']));
  assert.deepEqual(full.dropped, []); assert.deepEqual(full.relations.map((r: any) => r.id), all);
  const partial = await runDiscoveryPhase(ctx, replay(['orders', 'customers']));
  assert.ok(partial.dropped.includes('orders_region') && !partial.relations.some((r: any) => r.id === 'orders_region'));
  assert.ok(partial.relations.some((r: any) => r.id === 'orders_customer'));
});

test('S5: a universe that configured relations and lost all of them fails with DISCOVERY_NO_USABLE_RELATIONS; a blind universe stays valid', async () => {
  await assert.rejects(runDiscoveryPhase(context('AGENTFX'), replay([])), /DISCOVERY_NO_USABLE_RELATIONS/);
  const blind = context('TPCDS'); assert.equal(blind.cfg.relations.length, 0);
  const phase = await runDiscoveryPhase(blind, replay([]));
  assert.deepEqual([phase.relations.length, phase.dropped.length], [0, 0]);
});
