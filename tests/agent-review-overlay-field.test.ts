import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { offlineAgentDeps } from '../src/agent/offline-deps.ts';
import { activeReviewOverlay, withReviewOverlay } from '../src/agent/review-overlay.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { ROOT } from '../src/runtime.ts';

/** act 3: engine-run.reviewOverlay records the overlay in force, from what withReviewOverlay validated; absent without --review. Every overlay here is SYNTHETIC_TEST. */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const fixture = () => structuredClone(agentFixtures().find(item => item.alias === 'TPCDS')!);
const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'universes', 'reviews', 'TPCDS.review.json'), 'utf8'));
const synthetic = () => ({ ...structuredClone(real), origin: 'SYNTHETIC_TEST', approval: { approver: 'SYNTHETIC test approver', approvedAt: '2026-10-26T00:00:00Z', quote: 'SYNTHETIC TEST QUOTE: this is not a human approval', session: 'synthetic-test-session', package: 'synthetic/package.md' },
  relations: structuredClone(real.relations).slice(0, 3), deferred: [{ id: 'x.a__y.b', reason: 'M12' }] });
const run = (id: string) => { const f = fixture(); return runAgent('TPCDS', id, { ...offlineAgentDeps('TPCDS', f, new Script([...f.chooserScript])), persist: false, critic: false }) as Promise<any>; };

test('act 3: a run under an overlay records origin, sha256, approval, applied relations, deferred and a null negative control', async () => {
  const overlay = synthetic();
  const report = await withReviewOverlay('TPCDS', { overlay }, () => run('agent-overlay-field-1'), { allowSynthetic: true });
  const block = report.reviewOverlay;
  assert.ok(block, 'reviewOverlay present');
  assert.equal(block.origin, 'SYNTHETIC_TEST');
  assert.match(block.sha256, /^[0-9a-f]{64}$/);
  assert.equal(block.file, null, 'an inline overlay has no file');
  assert.deepEqual(block.approval, overlay.approval);
  assert.deepEqual(block.relations, overlay.relations.map((r: any) => r.id));
  assert.deepEqual(block.deferred, [{ id: 'x.a__y.b', reason: 'M12' }]);
  assert.deepEqual(block.negativeControl, { artifact: null });
  assert.equal(activeReviewOverlay('TPCDS'), undefined, 'the block is call-scoped: cleared when the call ends');
});

test('act 3: an overlay read from a file records its path relative to the project; no --review means no field', async () => {
  const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'overlay-field-'));
  try {
    const file = path.join(dir, 'T.review.json');
    fs.writeFileSync(file, JSON.stringify(synthetic()));
    const report = await withReviewOverlay('TPCDS', { file }, () => run('agent-overlay-field-2'), { allowSynthetic: true });
    assert.equal(report.reviewOverlay.file, path.relative(ROOT, file).split(path.sep).join('/'));
    assert.ok(!path.isAbsolute(report.reviewOverlay.file));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const plain = await run('agent-overlay-field-3');
  assert.equal('reviewOverlay' in plain, false);
});
