import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { runAgent } from '../src/agent/engine.ts';
import type { AssistChooser } from '../src/agent/critic-assist.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

const base = () => structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!);
/** More orders than the discovery sample: the first 20 follow customers c1..c3, the tail points at customers that do not exist (a counterexample the baseline never saw). */
const withFringe = (valid: boolean) => {
  const fx = base(), orders = fx.tables.orders.rows;
  for (let i = 4; i < 30; i++) orders.push([`o${i + 1}`, i < 20 || valid ? `c${(i % 3) + 1}` : `zz${i}`, `r${(i % 3) + 1}`]);
  return fx;
};
const scripted = (text: string, calls: string[] = []): AssistChooser => ({ suggest: async (_o, ids) => { calls.push(ids.join(',')); return { status: 'PASS', responseText: text,
  receipt: { totalTokens: 120 } as any }; } });
const run = (id: string, fx: ReturnType<typeof base>, criticAssist?: any, log: string[] = []) => runAgent('AGENTFX', id, { client: fixtureClient(universeConfig('AGENTFX'), fx.tables, log) as any,
  executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, criticAssist, now: () => '2026-10-24T00:00:00.000Z' }) as Promise<any>;
const SUGGEST = JSON.stringify({ counterprobes: [{ relationId: 'orders_customer', id: 'UNSEEN_SOURCE_KEY_FRINGE' }, { relationId: 'orders_customer', id: 'DROP_TABLE' }, { relationId: 'nope', id: 'UNSEEN_SOURCE_KEY_FRINGE' }] });

test('R5-2 hook: a model-suggested closed-catalog counterprobe runs through the typed counterprobe; invalid ids are rejected and recorded', async () => {
  const calls: string[] = [], log: string[] = [];
  const report = await run('agent-assist-1', withFringe(true), { chooser: scripted(SUGGEST, calls) }, log);
  assert.equal(calls.length, 1, 'one model call per batch');
  assert.equal(report.phases.critic.mode, 'ASSISTED');
  assert.equal(report.criticAssist.status, 'ASSISTED');
  assert.deepEqual(report.criticAssist.rejected.map((item: any) => item.reason).sort(), ['UNKNOWN_COUNTERPROBE_ID', 'UNKNOWN_RELATION']);
  assert.equal(report.criticAssist.executed.length, 1);
  assert.ok(report.budget.phases.byPhase.critic.used.queries >= 1, 'the counterprobe SQL is charged to the critic phase');
  assert.ok(report.budget.phases.byPhase.critic.used.tokens >= 120);
  assert.deepEqual(report.criticAssist.labels, ['MODEL_SUGGESTS_IDS_ONLY', 'CRITIC_RULE_DECIDES', 'DEGRADE_ONLY']);
});

test('R5-2 hook: only DEGRADED lowers a verdict, and a clean fringe never raises or changes one', async () => {
  const plain = await run('agent-assist-plain', withFringe(true));
  const confirmed = await run('agent-assist-ok', withFringe(true), { chooser: scripted(SUGGEST) });
  const verdicts = (r: any) => Object.fromEntries(r.decisions.map((d: any) => [d.relationId, d.verdict]));
  assert.deepEqual(verdicts(confirmed), verdicts(plain));
  const bad = await run('agent-assist-bad', withFringe(false), { chooser: scripted(SUGGEST) });
  const executed = bad.criticAssist.executed[0];
  if (executed.degraded) assert.notEqual(verdicts(bad).orders_customer, 'SOSTENIDA');
  else assert.equal(verdicts(bad).orders_customer, verdicts(plain).orders_customer);
  assert.equal(executed.degraded, bad.criticAssist.degradedRelationIds.includes('orders_customer'));
});

test('R5-2 hook: a failed or invalid model answer falls back to today\'s critic, labelled and without retry', async () => {
  const calls: string[] = [];
  const report = await run('agent-assist-fb', base(), { chooser: scripted('not json', calls) });
  assert.equal(calls.length, 1);
  assert.equal(report.criticAssist.status, 'FALLBACK_DETERMINISTIC');
  assert.equal(report.phases.critic.status, 'EVALUATED');
  assert.equal(report.phases.critic.mode, undefined, 'the deterministic critic ran as today');
  assert.ok(report.phases.critic.eligible >= 1);
});

test('R5-2 hook: without a model the assist is SKIPPED_NO_MODEL and the deterministic critic runs; absent option changes nothing', async () => {
  const noModel = await run('agent-assist-nm', base(), true), off = await run('agent-assist-off', base());
  assert.equal(noModel.criticAssist.status, 'SKIPPED_NO_MODEL');
  assert.equal(noModel.phases.critic.status, 'EVALUATED');
  assert.equal('criticAssist' in off, false);
  assert.deepEqual(noModel.decisions, off.decisions);
  assert.deepEqual(noModel.phases.critic, off.phases.critic);
});
