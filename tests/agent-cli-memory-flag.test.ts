import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runOfflineAgentCommand } from '../src/agent/cli-run.ts';
import { agentMemoryDir } from '../src/agent/memory.ts';
import { ROOT } from '../src/runtime.ts';

const runDir = (id: string) => path.join(ROOT, '.concordia', 'agent-runs', id);
const saved = (id: string) => JSON.parse(fs.readFileSync(path.join(runDir(id), 'engine-run.json'), 'utf8'));

test('runOfflineAgentCommand passes the memory option to the engine: absent without it, recorded with it', async () => {
  const plain = 'agent-agentfx-cli-memory-flag-off', withMemory = 'agent-agentfx-cli-memory-flag-on';
  const memoryDir = agentMemoryDir('AGENTFX'), memoryExisted = fs.existsSync(memoryDir);
  for (const id of [plain, withMemory]) fs.rmSync(runDir(id), { recursive: true, force: true });
  const log = console.log; console.log = () => {};
  try {
    await runOfflineAgentCommand('AGENTFX', { runId: plain });
    assert.equal(saved(plain).memory, undefined, 'memory is opt-in');
    await runOfflineAgentCommand('AGENTFX', { runId: withMemory, memory: true });
    assert.ok(saved(withMemory).memory, 'memory: true reaches runAgent and the run records its memory outcome');
  } finally {
    console.log = log; process.exitCode = 0;
    for (const id of [plain, withMemory]) fs.rmSync(runDir(id), { recursive: true, force: true });
    if (!memoryExisted) fs.rmSync(memoryDir, { recursive: true, force: true });
  }
});
