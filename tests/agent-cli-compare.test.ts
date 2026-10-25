import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { usageFor } from '../src/agent/cli-help.ts';
import { ROOT } from '../src/runtime.ts';

const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-tsx.mjs'), path.join(ROOT, 'src', 'cli.ts'), ...args], { encoding: 'utf8', cwd: ROOT });

test('agent-compare is documented in --help and requires both run ids', () => {
  assert.match(usageFor(['node', 'cli', 'agent-compare'])!, /--run-a .* --run-b/);
  const help = cli('agent-compare', '--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /agent-compare/);
  const missing = cli('agent-compare', '--run-a', 'agent-x');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /AGENT_COMPARE_RUN_IDS_REQUIRED/);
  assert.match(missing.stderr, /USAGE/);
});

test('agent-compare surfaces the report module error for an unknown run without writing anything', () => {
  const out = cli('agent-compare', '--run-a', 'agent-no-such-a', '--run-b', 'agent-no-such-b');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /AGENT_REPORT_ENGINE_RUN_NOT_FOUND/);
});
