import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { usageFor, wantsHelp } from '../src/agent/cli-help.ts';
import { ROOT } from '../src/runtime.ts';

const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'run-tsx.mjs'), path.join(ROOT, 'src', 'cli.ts'), ...args], { encoding: 'utf8', timeout: 60000 });

test('export commands document --run-id, --out and their error codes', () => {
  for (const command of ['export-odcs', 'export-negative']) {
    const usage = usageFor(['node', 'cli', command])!;
    assert.match(usage, new RegExp(`concordia ${command} --run-id <run> \[--out <path>\]`));
    assert.match(usage, /OUT_PATH_INVALID/);
    assert.match(usage, /RUN_NOT_FOUND/);
    assert.equal(wantsHelp(['node', 'cli', command, '--help']), true);
  }
});

test('--help on the export commands prints usage, exits 0 and touches nothing', () => {
  for (const command of ['export-odcs', 'export-negative']) {
    const out = cli(command, '--help');
    assert.equal(out.status, 0);
    assert.match(out.stdout, new RegExp(`concordia ${command}`));
  }
});
