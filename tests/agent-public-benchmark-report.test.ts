import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { runAgent } from '../src/agent/engine.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

const run = (alias: string) => {
  const cfg = universeConfig(alias), fixture = structuredClone(agentFixtures().find(i => i.alias === alias)!);
  return runAgent(alias, `agent-pb-${alias.toLowerCase()}`, { client: fixtureClient(cfg, fixture.tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false }) as Promise<any>;
};

test('M7-6 the declared publicBenchmark is copied verbatim to the report root; without it the field is absent', async () => {
  const declared = universeConfig('TPCDS').publicBenchmark;
  assert.deepEqual((await run('TPCDS')).publicBenchmark, { name: declared.name, note: declared.note });
  assert.equal('publicBenchmark' in (await run('AGENTFX')), false);
});
