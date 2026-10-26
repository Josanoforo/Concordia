import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import type { ComaBridge, ComaSchemaInput } from '../src/discovery/coma-provider.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** N57: the cap and pair counts of a blind COMA run are part of the persisted report, so a capped search is never read as exhaustive. */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const quietBridge: ComaBridge = (input: ComaSchemaInput) => ({ schemaVersion: 1, provider: 'valentine.Coma', version: '1.1.0', matches: input.pairs.map(pair => ({ source: pair.source, target: pair.target, matches: [] })) });
const fixture = (alias: string) => agentFixtures().find(item => item.alias === alias)!;

test('N57: a blind run records the pair counts and the cap in phases.coma.blind; a configured-relations run has no such section', async () => {
  const cfg = universeConfig('TPCDS');
  const blind: any = await runAgent('TPCDS', 'agent-n57-blind', { client: fixtureClient(cfg, fixture('TPCDS').tables) as any, chooser: new Script([...fixture('TPCDS').chooserScript]), comaBridge: quietBridge, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false });
  const section = blind.phases.coma.blind;
  assert.ok(section, 'phases.coma.blind is persisted');
  assert.deepEqual(Object.keys(section).sort(), ['cap', 'capped', 'order', 'pairs', 'tablePairs']);
  const tables = Object.keys(blind.phases.discovery.tables).length;
  assert.equal(section.tablePairs, tables * (tables - 1) / 2);
  assert.equal(section.pairs, Math.min(section.tablePairs, section.cap));
  assert.equal(section.capped, section.pairs < section.tablePairs);
  const cfgFx = universeConfig('AGENTFX');
  const plain: any = await runAgent('AGENTFX', 'agent-n57-plain', { client: fixtureClient(cfgFx, structuredClone(fixture('AGENTFX')).tables) as any, comaBridge: quietBridge, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false });
  assert.equal('blind' in plain.phases.coma, false);
});
