import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { usageFor } from '../src/agent/cli-help.ts';
import { agentMemoryDir } from '../src/agent/memory.ts';
import { ROOT } from '../src/runtime.ts';

const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-tsx.mjs'), path.join(ROOT, 'src', 'cli.ts'), ...args], { encoding: 'utf8', cwd: ROOT });
const runDir = (id: string) => path.join(ROOT, '.concordia', 'agent-runs', id);

test('--memory is documented in the agent help', () => {
  assert.match(usageFor(['node', 'cli', 'agent'])!, /--memory/);
});

test('agent --offline passes --memory from the command line to the run; without it the run has no memory record', () => {
  const off = 'agent-agentfx-cli-memory-wiring-off', on = 'agent-agentfx-cli-memory-wiring-on';
  const memoryDir = agentMemoryDir('AGENTFX'), memoryExisted = fs.existsSync(memoryDir);
  for (const id of [off, on]) fs.rmSync(runDir(id), { recursive: true, force: true });
  try {
    assert.equal(cli('agent', '--universe', 'AGENTFX', '--offline', '--run-id', off).status, 0);
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir(off), 'engine-run.json'), 'utf8')).memory, undefined);
    assert.equal(cli('agent', '--universe', 'AGENTFX', '--offline', '--memory', '--run-id', on).status, 0);
    assert.ok(JSON.parse(fs.readFileSync(path.join(runDir(on), 'engine-run.json'), 'utf8')).memory, 'the run records its memory outcome');
  } finally {
    for (const id of [off, on]) fs.rmSync(runDir(id), { recursive: true, force: true });
    if (!memoryExisted) fs.rmSync(memoryDir, { recursive: true, force: true });
  }
});
