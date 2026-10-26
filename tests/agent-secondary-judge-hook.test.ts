import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import type { SecondaryJudge } from '../src/agent/secondary-judge.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

class Elector implements ActionChooser {
  private step = 0;
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const selected = this.script[Math.min(this.step++, this.script.length - 1)]!;
    return { stage, status: 'PASS', decisionStatus: allowed.includes(selected) ? 'VALID' : 'INVALID', requestedModel: 'scripted', selected, reason: 'scripted', promptHash: `h${this.step}`, utc: '2026-10-24T00:00:00.000Z', receipt: { totalTokens: 10 } as any };
  }
}
const judgeThatDisagrees = (calls: string[]): SecondaryJudge => ({ judge: async (_q, ordered) => { calls.push(ordered.join('|')); return { status: 'PASS', responseText: JSON.stringify({ choice: ordered.find(id => id !== 'READ_CUSTOMER_PROFILE') ?? 'NONE' }), receipt: { totalTokens: 15, model: 'judge-model' } as any }; } });
const run = (id: string, secondaryJudge?: any) => runAgent('AGENTFX', id, { client: fixtureClient(universeConfig('AGENTFX'), structuredClone(agentFixtures().find(i => i.alias === 'AGENTFX')!).tables) as any,
  chooser: new Elector(['READ_CUSTOMER_PROFILE', 'READ_REGION_REFERENCE', 'STOP_EXPLORATION']), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false, secondaryJudge, now: () => '2026-10-24T00:00:00.000Z' }) as Promise<any>;
const tie = { ambiguity: () => ({ tie: true, candidates: ['READ_CUSTOMER_PROFILE', 'READ_REGION_REFERENCE'] }) };

test('R5-6 hook: off (default) is an exact pass-through; an explicit false or enabled:false changes nothing', async () => {
  const plain = await run('agent-judge-off'), explicit = await run('agent-judge-false', false), disabled = await run('agent-judge-dis', { enabled: false, judge: judgeThatDisagrees([]) });
  for (const other of [explicit, disabled]) {
    assert.deepEqual(other.decisions, plain.decisions);
    assert.deepEqual(other.phases.exploration.actions, plain.phases.exploration.actions);
    assert.deepEqual(other.phases.exploration.calls, plain.phases.exploration.calls);
    assert.equal('secondaryJudge' in other, false);
  }
  assert.equal(plain.phases.exploration.calls.some((call: any) => call.secondaryJudge), false);
});

test('R5-6 hook: on, a disagreeing judge only leaves a non-decisive note in calls[].secondaryJudge; actions and decisions are identical', async () => {
  const plain = await run('agent-judge-base'), seen: string[] = [];
  const judged = await run('agent-judge-on', { judge: judgeThatDisagrees(seen), ...tie });
  const notes = judged.phases.exploration.calls.map((call: any) => call.secondaryJudge).filter(Boolean);
  assert.ok(notes.length >= 1 && seen.length >= 1, 'the judge was consulted under real ambiguity');
  assert.ok(notes.every((note: any) => note.label === 'NOTA_NO_DECISORIA'));
  assert.ok(notes.some((note: any) => note.status === 'DISAGREES'));
  assert.deepEqual(judged.phases.exploration.actions.map((a: any) => a.action), plain.phases.exploration.actions.map((a: any) => a.action));
  assert.deepEqual(judged.decisions, plain.decisions);
  assert.deepEqual(judged.secondaryJudge, { enabled: true, status: 'ACTIVE', label: 'NOTA_NO_DECISORIA' });
});

test('R5-6 hook: true without a judge (no model) is recorded as SKIPPED_NO_MODEL and the run is unchanged', async () => {
  const plain = await run('agent-judge-nm0'), noModel = await run('agent-judge-nm', true);
  assert.deepEqual(noModel.secondaryJudge, { enabled: true, status: 'SKIPPED_NO_MODEL', label: 'NOTA_NO_DECISORIA' });
  assert.deepEqual(noModel.decisions, plain.decisions);
  assert.deepEqual(noModel.phases.exploration.calls, plain.phases.exploration.calls);
});
