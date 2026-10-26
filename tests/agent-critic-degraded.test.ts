import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { runAgent } from '../src/agent/engine.ts';
import type { AssistChooser } from '../src/agent/critic-assist.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/**
 * M16: offline end-to-end DEGRADED. The AGENTFX fixture is extended so that the first 20 orders (the discovery sample) all point at existing customers, while the
 * rows past the sample are a counterexample the baseline never saw: 3 of 23 unseen customer keys exist (c4..c6, rows the baseline orders never reference), 20 do not.
 * A model-suggested closed-catalog counterprobe (scripted, ids only) finds it; the critic rule, not the model, degrades the verdict.
 */
const fixture = () => {
  const fx = structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!), orders = fx.tables.orders.rows;
  for (const key of ['c4', 'c5', 'c6']) fx.tables.customers.rows.push([key, `N${key}`, 's1']);
  for (let i = 4; i < 20; i++) orders.push([`o${i + 1}`, `c${(i % 3) + 1}`, `r${(i % 3) + 1}`]);
  for (let i = 20; i < 43; i++) orders.push([`o${i + 1}`, i < 23 ? `c${i - 16}` : `zz${i}`, `r${(i % 3) + 1}`]);
  return fx;
};
const SUGGEST = JSON.stringify({ counterprobes: [{ relationId: 'orders_customer', id: 'UNSEEN_SOURCE_KEY_FRINGE' }] });
const chooser = (text: string): AssistChooser => ({ suggest: async () => ({ status: 'PASS', responseText: text, receipt: { totalTokens: 120 } as any }) });
const run = (id: string, criticAssist?: any, critic?: false) => runAgent('AGENTFX', id, { client: fixtureClient(universeConfig('AGENTFX'), fixture().tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC',
  persist: false, critic, criticAssist, now: () => '2026-10-24T00:00:00.000Z' }) as Promise<any>;
const verdicts = (report: any) => Object.fromEntries(report.decisions.map((item: any) => [item.relationId, [item.verdict, item.reasonCodes[0]]]));

test('M16 without any critic the same fixture sustains orders_customer: the counterexample lives only past the discovery sample', async () => {
  const plain = await run('agent-m16-plain', undefined, false);
  assert.deepEqual(verdicts(plain).orders_customer, ['SOSTENIDA', 'bounded_sample_key_membership']);
  assert.equal(plain.criticAssist, undefined);
});

test('M16 with the assist the typed counterprobe degrades exactly that relation: critic DEGRADED, verdict lowered by the rule, the rest untouched', async () => {
  const plain = await run('agent-m16-base', undefined, false), report = await run('agent-m16-degraded', { chooser: chooser(SUGGEST) });
  assert.equal(report.phases.critic.mode, 'ASSISTED');
  assert.equal(report.phases.critic.summary.degraded, 1);
  const [executed] = report.criticAssist.executed;
  assert.deepEqual([executed.relationId, executed.status, executed.classification, executed.degraded], ['orders_customer', 'DEGRADED', 'COUNTEREXAMPLE', true]);
  assert.deepEqual(report.criticAssist.degradedRelationIds, ['orders_customer']);
  assert.deepEqual(report.criticAssist.labels, ['MODEL_SUGGESTS_IDS_ONLY', 'CRITIC_RULE_DECIDES', 'DEGRADE_ONLY']);
  assert.deepEqual(verdicts(report).orders_customer, ['ENGAÑOSA', 'observed_key_missing_from_referenced_sample']);
  for (const id of ['orders_region', 'orders_order_trap']) assert.deepEqual(verdicts(report)[id], verdicts(plain)[id], `${id} is untouched`);
  assert.ok(report.budget.phases.byPhase.critic.used.queries >= 2, 'the counterprobe SQL is charged to the critic phase');
});

test('M16 the model only names ids: an answer with no valid id degrades nothing, and the DEGRADED outcome needs real counterevidence', async () => {
  const none = await run('agent-m16-none', { chooser: chooser(JSON.stringify({ counterprobes: [{ relationId: 'orders_customer', id: 'DROP_TABLE' }] })) });
  assert.deepEqual([none.criticAssist.executed, none.criticAssist.degradedRelationIds], [[], []], 'an id outside the closed catalog executes nothing and degrades nothing');
  assert.deepEqual(none.criticAssist.rejected.map((item: any) => item.reason), ['UNKNOWN_COUNTERPROBE_ID']);
  const clean = fixture(); clean.tables.orders.rows.splice(23);
  const ok = await runAgent('AGENTFX', 'agent-m16-clean', { client: fixtureClient(universeConfig('AGENTFX'), clean.tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false,
    criticAssist: { chooser: chooser(SUGGEST) }, now: () => '2026-10-24T00:00:00.000Z' }) as any;
  assert.deepEqual(ok.criticAssist.degradedRelationIds, [], 'a fringe that holds up degrades nothing');
  assert.equal(verdicts(ok).orders_customer[0], 'SOSTENIDA');
  assert.equal(ok.criticAssist.executed[0].degraded, false);
});
