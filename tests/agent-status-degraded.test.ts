import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { ROOT } from '../src/runtime.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { runAgent } from '../src/agent/engine.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

const run = (extra: Record<string, unknown>) => runAgent('AGENTFX', 'agent-degraded', { client: fixtureClient(universeConfig('AGENTFX'), structuredClone(agentFixtures().find(i => i.alias === 'AGENTFX')!).tables) as any,
  executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false, ...extra }) as Promise<any>;
const bridgeOk = (input: any) => ({ schemaVersion: 1, provider: 'valentine.Coma', version: '1.1.0', configuration: { max_n: 0, use_instances: false, use_schema: true, delta: 0.15, threshold: 0, instance_weight: 1 },
  matches: input.pairs.map((pair: any) => ({ source: pair.source, target: pair.target, matches: [{ sourceColumn: pair.allowed[0].sourceColumn, targetColumn: pair.allowed[0].targetColumn, rawScore: 0.9 }, { sourceColumn: 'order_id', targetColumn: pair.allowed[0].targetColumn, rawScore: 0.4 }] })) });

test('G0-4: a COMA bridge that really fails is COMA_FAILED and the status is DEGRADED', async () => {
  const report = await run({ comaRequested: true, comaBridge: () => { throw new Error('bridge crashed'); } });
  assert.equal(report.status, 'DEGRADED');
  assert.ok(report.degradations.some((d: any) => d.phase === 'coma' && d.code === 'COMA_FAILED'));
  assert.equal(report.postComa.status, 'COMA_FAILED', 'the engine consumes the post-COMA state, not its own guess');
  assert.ok(report.degradations.find((d: any) => d.code === 'COMA_FAILED').detail.length > 0, 'the provider error codes are copied');
});

test('G0-4: out-of-scope proposals are the expected result of a run and are not an error', async () => {
  const report = await run({ comaRequested: true, comaBridge: bridgeOk });
  assert.ok(report.phases.coma.outOfScopeProposals.length >= 1);
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.degradations.some((d: any) => d.phase === 'coma'), false);
});

test('G0-10: with --memory, a memory ERROR makes the run DEGRADED even though everything else ran', async () => {
  const report = await run({ memory: { dir: path.join(ROOT, 'out', 'nope') } });
  assert.equal(report.memory.status, 'ERROR');
  assert.equal(report.status, 'DEGRADED');
  assert.ok(report.degradations.some((d: any) => d.code === 'MEMORY_ERROR'));
});

test('status priority and informative degradations: DEGRADED_NO_MODEL wins over DEGRADED; budget and --no-model notes alone keep COMPLETED', async () => {
  const both = await run({ modelRequested: true, memory: { dir: path.join(ROOT, 'out', 'nope') } });
  assert.equal(both.status, 'DEGRADED_NO_MODEL');
  const plain = await run({});
  assert.equal(plain.status, 'COMPLETED');
});
