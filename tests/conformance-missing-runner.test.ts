import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../src/runtime.ts';

/** M18: without the upstream H-MEM runner (an isolated copy has no ../meterless-reference) the conformance script says so and exits 2, distinct from a conformance FAIL (1). */
const run = (env: Record<string, string>) => spawnSync(process.execPath, ['scripts/run-tsx.mjs', 'scripts/conformance.ts'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env } });

test('a missing runner is a clear exit 2 that names the variable and the checkout, writes no evidence, and is not a FAIL', () => {
  const evidenceBefore = fs.existsSync(path.join(ROOT, 'out', 'U1', 'conformance.json')) ? fs.statSync(path.join(ROOT, 'out', 'U1', 'conformance.json')).mtimeMs : null;
  const missing = path.join(ROOT, '.concordia', 'no-such-runner', 'runner.ts'), result = run({ HMEM_CONFORMANCE_RUNNER: missing });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /H-MEM conformance runner not found/); assert.match(result.stderr, /HMEM_CONFORMANCE_RUNNER/); assert.match(result.stderr, /meterless-reference/);
  assert.equal(result.stdout, '');
  const evidenceAfter = fs.existsSync(path.join(ROOT, 'out', 'U1', 'conformance.json')) ? fs.statSync(path.join(ROOT, 'out', 'U1', 'conformance.json')).mtimeMs : null;
  assert.equal(evidenceAfter, evidenceBefore, 'no evidence file is written when the runner is missing');
});
