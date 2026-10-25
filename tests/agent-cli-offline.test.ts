import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runOfflineAgentCommand } from '../src/agent/cli-run.ts';
import { ROOT } from '../src/runtime.ts';

const runDir = (id: string) => path.join(ROOT, '.concordia', 'agent-runs', id);

test('agent --offline runs the loop over the synthetic fixture and labels it as such', async () => {
  const runId = 'agent-agentfx-cli-offline-test-1';
  fs.rmSync(runDir(runId), { recursive: true, force: true });
  const log = console.log; console.log = () => {};
  try {
    const summary = await runOfflineAgentCommand('AGENTFX', { runId });
    assert.equal(summary.mode, 'OFFLINE_FIXTURE');
    assert.equal(summary.dataOrigin, 'SYNTHETIC');
    assert.equal(summary.status, 'COMPLETED');
    const saved = JSON.parse(fs.readFileSync(path.join(runDir(runId), 'engine-run.json'), 'utf8'));
    assert.equal(saved.executionMode, 'LOCAL');
  } finally { console.log = log; fs.rmSync(runDir(runId), { recursive: true, force: true }); process.exitCode = 0; }
});

test('agent --offline refuses a universe without a fixture or an unknown one', async () => {
  await assert.rejects(runOfflineAgentCommand('NOPE', {}), /INVALID_UNIVERSE/);
});
