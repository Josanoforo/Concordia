import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/engine.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { readJson } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';

class Script implements ActionChooser {
  constructor(private script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION';
    return { stage, status: 'PASS', decisionStatus: 'VALID', requestedModel: 'scripted', selected: allowed.includes(next) ? next : allowed[allowed.length - 1], reason: 'scripted offline choice', promptHash: 'x', utc: '2026-10-25T00:00:00.000Z' };
  }
}

test('each exploration call in engine-run keeps the action ids that were offered to it (judge agreement can be measured)', async () => {
  const fx = readJson('eval/agent/AGENTFX.json') as any;
  const report: any = await runAgent('AGENTFX', 'agent-agentfx-allowed-test', { client: fixtureClient(universeConfig('AGENTFX'), fx.tables) as any, chooser: new Script(['READ_CUSTOMER_PROFILE']), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false });
  const calls = report.phases.exploration.calls;
  assert.ok(calls.length >= 1);
  for (const call of calls) { assert.ok(Array.isArray(call.allowed) && call.allowed.length >= 1, 'allowed is recorded'); assert.ok(call.allowed.includes(call.selected), 'the selection is one of the offered ids'); }
  assert.ok(calls[0].allowed.includes('STOP_EXPLORATION'));
  assert.equal('responseText' in calls[0], false);
});
