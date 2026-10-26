import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { usageFor } from '../src/agent/cli-help.ts';
import { runOfflineAgent } from '../src/agent/cli-run.ts';
import { ROOT } from '../src/runtime.ts';

const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-tsx.mjs'), path.join(ROOT, 'src', 'cli.ts'), ...args], { encoding: 'utf8', cwd: ROOT });

test('agent-compare-multi is documented, needs --runs and at least two runs, and reports unknown runs', () => {
  assert.match(usageFor(['node', 'cli', 'agent-compare-multi'])!, /--runs/);
  const help = cli('agent-compare-multi', '--help');
  assert.equal(help.status, 0); assert.match(help.stdout, /agent-compare-multi/);
  const none = cli('agent-compare-multi');
  assert.equal(none.status, 1); assert.match(none.stderr, /AGENT_COMPARE_RUNS_REQUIRED/); assert.match(none.stderr, /USAGE/);
  const one = cli('agent-compare-multi', '--runs', 'agent-only-one');
  assert.equal(one.status, 1); assert.match(one.stderr, /AGENT_COMPARE_NEEDS_TWO_RUNS/);
  const unknown = cli('agent-compare-multi', '--runs', 'agent-no-such-a,agent-no-such-b');
  assert.equal(unknown.status, 1); assert.match(unknown.stderr, /AGENT_REPORT_ENGINE_RUN_NOT_FOUND/);
});

test('smoke: three offline fixture runs produce one comparison table with the N columns', async () => {
  const ids = ['agent-cmpmulti-test-a', 'agent-cmpmulti-test-b', 'agent-cmpmulti-test-c'], dirs = ids.map(id => path.join(ROOT, '.concordia', 'agent-runs', id));
  const file = path.join(ROOT, '.concordia', 'agent-runs', `compare-multi-${ids.join('_')}.md`);
  try {
    await runOfflineAgent('AGENTFX', { runId: ids[0]! }); await runOfflineAgent('GTFSAGENT', { runId: ids[1]! }); await runOfflineAgent('TPCDS', { runId: ids[2]! });
    const out = cli('agent-compare-multi', '--runs', ids.join(','));
    assert.equal(out.status, 0, out.stderr);
    const summary = JSON.parse(out.stdout.trim().split('\n').pop()!);
    assert.deepEqual(summary.runs, ids); assert.equal(summary.files.length, 1);
    const md = fs.readFileSync(path.join(ROOT, summary.files[0]), 'utf8');
    assert.match(md, /# Comparacion de 3 corridas/);
    for (const id of ids) assert.match(md, new RegExp(id));
    assert.match(md, /\| Modo de ejecucion \| LOCAL \| LOCAL \| LOCAL \|/);
  } finally { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(file, { force: true }); }
});
