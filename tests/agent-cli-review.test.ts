import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { agentFlagOptions, usageFor } from '../src/agent/cli-help.ts';
import { runOfflineAgent } from '../src/agent/cli-run.ts';
import { ROOT } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

const overlay = 'universes/reviews/TPCDS.review.json';
const runs = ['agent-tpcds-review-cli-a', 'agent-tpcds-review-cli-b'];
const clean = () => { for (const id of runs) fs.rmSync(path.join(ROOT, '.concordia', 'agent-runs', id), { recursive: true, force: true }); };

test('--review is parsed, documented and passed through; absent means no key', () => {
  assert.deepEqual(agentFlagOptions(['node', 'cli', 'agent'], undefined, overlay), { review: overlay });
  assert.deepEqual(agentFlagOptions(['node', 'cli', 'agent'], undefined), {});
  assert.match(usageFor(['node', 'cli', 'agent'])!, /--review <file>/);
  assert.match(usageFor(['node', 'cli', 'agent'])!, /not something the agent discovered/);
});

test('offline TPCDS with the human review overlay gets decisions from the approved contracts; without it the universe stays blind; the overlay is scoped to the call', async () => {
  try {
    const blind = await runOfflineAgent('TPCDS', { runId: runs[0]! });
    // TPCDS requires MODEL_ADVERSARIAL (Round 9 full run): without --review the only decisions come from model-reviewed contracts, never from a human overlay.
    assert.ok((blind.report.decisions ?? []).every((item: any) => item.reviewOrigin === 'MODEL_REVIEWED'), 'blind: no human contract, so any decision is model-reviewed');
    assert.equal(blind.summary.review, null);
    assert.ok(!JSON.stringify(blind.report.decisions ?? []).includes('overlayOrigin":"HUMAN_REVIEW'));
    const reviewed = await runOfflineAgent('TPCDS', { runId: runs[1]!, review: overlay });
    assert.equal(reviewed.summary.review, overlay);
    assert.ok(reviewed.report.decisions.length >= 1, 'the approved contracts produce decisions');
    assert.ok(reviewed.report.decisions.some((item: any) => item.verdict === 'SOSTENIDA'));
    assert.deepEqual(universeConfig('TPCDS').relations, [], 'the universe is blind again after the call');
  } finally { clean(); }
});

test('--review fails closed: a bad path or an overlay of another universe stops before any run', async () => {
  await assert.rejects(() => runOfflineAgent('TPCDS', { runId: runs[0]!, review: '../outside.review.json' }), /REVIEW_FILE_PATH_INVALID/);
  await assert.rejects(() => runOfflineAgent('TPCDS', { runId: runs[0]!, review: 'universes/reviews/NO_SUCH.review.json' }), /REVIEW_FILE_PATH_INVALID/);
  await assert.rejects(() => runOfflineAgent('GTFSAGENT', { runId: runs[0]!, review: overlay }), /REVIEW_UNIVERSE_MISMATCH/);
  assert.equal(fs.existsSync(path.join(ROOT, '.concordia', 'agent-runs', runs[0]!, 'engine-run.json')), false, 'nothing ran');
  clean();
});

test('--negative-control requires --review, passes through only when given, and is documented', async () => {
  const control = '.concordia/agent-runs/some-run/negative-control.json';
  assert.deepEqual(agentFlagOptions(['node', 'cli', 'agent'], undefined, overlay, control), { review: overlay, negativeControl: control });
  assert.deepEqual(agentFlagOptions(['node', 'cli', 'agent'], undefined, overlay), { review: overlay });
  assert.throws(() => agentFlagOptions(['node', 'cli', 'agent'], undefined, undefined, control), /NEGATIVE_CONTROL_REQUIRES_REVIEW/);
  assert.match(usageFor(['node', 'cli', 'agent'])!, /--negative-control[^\n]*requires --review[^\n]*engine-run\.reviewOverlay\.negativeControl/);
});

test('the offline run hands the negative-control path to the engine, which fails closed on a bad one', async () => {
  const id = runs[0]!;
  try {
    await assert.rejects(() => runOfflineAgent('TPCDS', { runId: id, review: overlay, negativeControl: '../outside/negative-control.json' }), /NEGATIVE_CONTROL_PATH_INVALID/);
    await assert.rejects(() => runOfflineAgent('TPCDS', { runId: id, negativeControl: 'out/whatever/negative-control.json' }), /NEGATIVE_CONTROL_REQUIRES_REVIEW/);
  } finally { clean(); }
});
