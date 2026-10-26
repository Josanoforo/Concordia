import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** P6 wiring: exploration hints reach the probe ranking. They change the ORDER (and so what fits a tight budget), never a verdict. */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'region codes line up', promptHash: 'x', utc: '2026-10-26T00:00:00.000Z' };
  }
}
const cfg = universeConfig('AGENTFX');
const run = (script: string[]) => runAgent('AGENTFX', 'agent-hints-run', { client: fixtureClient(cfg, structuredClone(agentFixtures().find(i => i.alias === 'AGENTFX')!).tables) as any, chooser: new Script(script), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false }) as Promise<any>;
const verdicts = (report: any) => Object.fromEntries(report.decisions.map((d: any) => [d.relationId, d.verdict]));

test('P6 run: a chosen read puts its relations first in the probe order, is recorded, and changes no verdict', async () => {
  const plain = await run(['STOP_EXPLORATION']);
  assert.equal('hints' in plain.phases.exploration, false, 'no read, no hints');
  assert.equal('hints' in plain.probeSelection, false);
  const hinted = await run(['READ_REGION_REFERENCE', 'STOP_EXPLORATION']);
  assert.deepEqual(hinted.phases.exploration.hints.map((h: any) => h.relationId), ['orders_region']);
  assert.equal(hinted.probeSelection.hints.reordered, true);
  assert.deepEqual(hinted.probeSelection.hints.applied, ['orders_region']);
  assert.equal(hinted.probeSelection.selected[0], 'orders_region');
  assert.notDeepEqual(hinted.probeSelection.selected, plain.probeSelection.selected);
  assert.deepEqual([...hinted.probeSelection.selected].sort(), [...plain.probeSelection.selected].sort(), 'the same relations are probed');
  assert.deepEqual(verdicts(hinted), verdicts(plain), 'verdicts are identical');
});
