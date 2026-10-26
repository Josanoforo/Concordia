import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
// @ts-expect-error plain ESM script without types
import { ALL_STEPS, formatSummary, parseTestSummary } from '../scripts/gate-clean.mjs';

test('gate:clean parses the node:test summary and prints one line with every step', () => {
  const counts = parseTestSummary('ℹ tests 650\nℹ suites 0\nℹ pass 644\nℹ fail 0\nℹ cancelled 0\nℹ skipped 6\n');
  assert.deepEqual(counts, { pass: 644, fail: 0, skipped: 6 });
  assert.deepEqual(parseTestSummary('nothing'), { pass: null, fail: null, skipped: null });
  const ok = formatSummary('abc1234', { typecheck: { ok: true }, test: { ok: true, detail: '644 pass, 0 fail' }, 'eval-agent': { ok: true }, 'check-secrets': { ok: true } }, 90);
  assert.equal(ok, 'GATE_CLEAN PASS head=abc1234 typecheck=ok test=ok(644 pass, 0 fail) eval-agent=ok check-secrets=ok 90s');
  assert.match(formatSummary('abc1234', { typecheck: { ok: true }, test: { ok: false, detail: '1 fail' } }, 5), /^GATE_CLEAN FAIL .*test=FAIL\(1 fail\)/);
  assert.deepEqual(ALL_STEPS, ['typecheck', 'test', 'eval-agent', 'check-secrets']);
});

// A clean copy of HEAD (what gate:clean itself runs in) has no .git, so there is nothing to archive: skip there.
test('gate:clean runs a real step on a clean copy of HEAD without touching the checkout', { skip: !existsSync('.git') }, async () => {
  // @ts-expect-error plain ESM script without types
  const { gateClean } = await import('../scripts/gate-clean.mjs');
  const fs = await import('node:fs'); const path = await import('node:path');
  const modules = path.join(process.cwd(), 'node_modules', 'typescript');
  const out = gateClean(['--steps', 'check-secrets']);
  assert.match(out.line, /^GATE_CLEAN (PASS|FAIL) head=\S+ check-secrets=(ok|FAIL) \d+s$/);
  assert.ok(fs.existsSync(modules), 'node_modules survives the cleanup (the junction is never followed)');
});
