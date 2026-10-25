import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runAgent } from '../src/agent/engine.ts';
import { agentMemoryDir } from '../src/agent/memory.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

// The memory store is scoped per execution mode and data origin, so claims from offline SYNTHETIC runs never reach a LIVE run.
test('agent memory is scoped per execution mode and data origin', async () => {
  const fixture = agentFixtures().find(item => item.alias === 'U2')!;
  const local = agentMemoryDir('U2', { executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' });
  const live = agentMemoryDir('U2', { executionMode: 'LIVE', dataOrigin: 'USER' });
  assert.notEqual(local, live);
  assert.notEqual(local, agentMemoryDir('U2'));
  const existed = [local, live].map(dir => fs.existsSync(dir));
  const run = (runId: string, executionMode: 'LOCAL' | 'LIVE', dataOrigin: 'SYNTHETIC' | 'USER') => runAgent('U2', runId, {
    client: fixtureClient(universeConfig('U2'), structuredClone(fixture.tables)) as any, executionMode, dataOrigin, persist: false, memory: true, now: () => '2026-10-25T00:00:00Z' }) as Promise<any>;
  try {
    const offline = await run('agent-u2-memory-origin-local', 'LOCAL', 'SYNTHETIC');
    assert.match(offline.memory.scope, /agent-memory\/U2\/LOCAL-SYNTHETIC$/);
    const other = await run('agent-u2-memory-origin-live', 'LIVE', 'USER');
    assert.match(other.memory.scope, /agent-memory\/U2\/LIVE-USER$/);
    assert.equal(other.memory.reuse?.mode, 'COLD', 'a different origin starts cold even after an offline run wrote claims');
    assert.ok(other.memory.reuse.reprobe.every((item: any) => item.reason === 'NO_MEMORY'));
  } finally {
    [local, live].forEach((dir, index) => { if (!existed[index]) fs.rmSync(dir, { recursive: true, force: true }); });
  }
});
