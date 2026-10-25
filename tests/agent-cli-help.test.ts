import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { helpHint, usageFor, wantsHelp } from '../src/agent/cli-help.ts';
import { ROOT } from '../src/runtime.ts';

const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-tsx.mjs'), path.join(ROOT, 'src', 'cli.ts'), ...args], { encoding: 'utf8', cwd: ROOT });

test('usage resolves per command and agent continue is distinct', () => {
  const argv = (...a: string[]) => ['node', 'cli', ...a];
  assert.match(usageFor(argv('agent'))!, /--offline/);
  assert.match(usageFor(argv('agent', 'continue'))!, /--run-id/);
  assert.match(usageFor(argv('eval-agent'))!, /eval-agent/);
  assert.match(usageFor(argv('agent-report'))!, /agent-report/);
  assert.equal(usageFor(argv('review')), undefined);
  assert.equal(wantsHelp(argv('agent', '--help')), true);
  assert.equal(wantsHelp(argv('agent', '--universe', 'U1')), false);
  assert.match(helpHint(argv('agent-report'))!, /^USAGE/);
});

test('--help prints usage and exits 0 without touching anything', () => {
  const out = cli('agent', '--help');
  assert.equal(out.status, 0);
  assert.match(out.stdout, /concordia agent --universe/);
});

test('a missing argument fails with the code and then the usage', () => {
  const out = cli('agent-report');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /FAIL .*AGENT_RUN_ID_REQUIRED/);
  assert.match(out.stderr, /USAGE\nconcordia agent-report --run-id/);
});
