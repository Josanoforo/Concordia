import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { candidateReviewFor, liveAgentDeps, runOfflineAgent } from '../src/agent/cli-run.ts';
import { ROOT, SafeError } from '../src/runtime.ts';

const fakeNightshift: any = { route: 'fake', chat: async () => { throw new Error('constructing the review must not call the model'); } };
const id = 'agent-nwch-candidate-review-cli-test';
const clean = () => { for (const name of [id, id + '-tpcds']) fs.rmSync(path.join(ROOT, '.concordia', 'agent-runs', name), { recursive: true, force: true }); };

test('only MODEL_ADVERSARIAL / BOTH universes get a candidate review; a HUMAN universe gets none', () => {
  const human = candidateReviewFor('U3', { offline: true }); // U3 declares no mode: HUMAN (TPCDS moved to MODEL_ADVERSARIAL for the Round 9 full run)
  assert.deepEqual([human.reviewMode, human.status, human.review], ['HUMAN', 'NOT_REQUIRED', undefined]);
  const modelLive = candidateReviewFor('NWCH', { offline: false, nightshift: fakeNightshift });
  assert.deepEqual([modelLive.reviewMode, modelLive.status, typeof modelLive.review], ['MODEL_ADVERSARIAL', 'MODEL', 'function']);
  const offline = candidateReviewFor('NWCH', { offline: true });
  assert.deepEqual([offline.status, typeof offline.review], ['STAND_IN_OFFLINE', 'function']);
});

test('live without a model fails closed: --no-model, or a model client that could not be built, never degrades silently', () => {
  assert.throws(() => candidateReviewFor('NWCH', { offline: false }), (error: any) => error.code === 'MODEL_REVIEW_REQUIRES_MODEL' && /MODEL_ADVERSARIAL/.test(error.detail));
  assert.throws(() => candidateReviewFor('NWCH', { offline: false, cause: { code: 'NIGHTSHIFT_KEY_MISSING' } }), (error: any) => error.code === 'NIGHTSHIFT_KEY_MISSING');
  assert.doesNotThrow(() => candidateReviewFor('U3', { offline: false }), 'a universe that does not need the review runs without a model as before');
});

test('the live engine deps carry the review only when there is one', () => {
  const review = candidateReviewFor('NWCH', { offline: false, nightshift: fakeNightshift }).review;
  assert.equal((liveAgentDeps({ client: {}, options: { model: true, coma: true }, argv: [], candidateReview: review }) as any).candidateReview, review);
  assert.equal('candidateReview' in liveAgentDeps({ client: {}, options: { model: true, coma: true }, argv: [] }), false);
});

test('offline NWCH runs with the stand-in review and the summary shows the review mode and status; a HUMAN universe shows NOT_REQUIRED', async () => {
  try {
    const nwch = await runOfflineAgent('NWCH', { runId: id });
    assert.equal(nwch.summary.reviewMode, 'MODEL_ADVERSARIAL');
    assert.ok(['APPLIED', 'NOTHING_APPROVED'].includes(nwch.summary.candidateReview), `the stand-in review reached the engine and ran: ${nwch.summary.candidateReview}`);
    assert.equal(nwch.report.phases.candidateReview.mode, 'MODEL_ADVERSARIAL');
    const tpcds = await runOfflineAgent('U3', { runId: id + '-tpcds' });
    assert.deepEqual([tpcds.summary.reviewMode, tpcds.summary.candidateReview], ['HUMAN', 'NOT_REQUIRED']);
  } finally { clean(); }
});

test('the CLI injects ONLY deps.candidateReview (R-1): it never builds the post-verdict model review path', async () => {
  const sources = ['src/cli.ts', 'src/agent/cli-run.ts', 'src/agent/cli-help.ts', 'src/agent/cli-export.ts', 'src/agent/demo-tpcds.ts', 'src/agent/offline-deps.ts'];
  for (const file of sources) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, file), 'utf8'), /createModelReviewStage|packetsFromTargets|\bmodelReview\s*[:=]/, `${file} never wires the post-verdict path`);
  const review = candidateReviewFor('NWCH', { offline: false, nightshift: fakeNightshift }).review;
  const deps: any = liveAgentDeps({ client: {}, options: { model: true, coma: true }, argv: [], candidateReview: review });
  assert.equal('modelReview' in deps, false); assert.equal(deps.candidateReview, review);
});

test('R10: manifest reviewCascade.enabled turns the cascade on in both review builders; absent/false builds the review as before', async () => {
  const { reviewCascadeOptions } = await import('../src/agent/cli-run.ts');
  assert.deepEqual(reviewCascadeOptions({ reviewCascade: { enabled: true } }), { config: { cascade: true } });
  for (const off of [{}, { reviewCascade: {} }, { reviewCascade: { enabled: false } }, { reviewCascade: { enabled: 'yes' } }, undefined]) assert.deepEqual(reviewCascadeOptions(off), {});
  const source = fs.readFileSync(path.join(ROOT, 'src/agent/cli-run.ts'), 'utf8');
  assert.ok(source.includes('createCandidateReview({ standIn: true, thresholds, ...cascade })'));
  assert.ok(source.includes('createCandidateReview({ model: input.nightshift, thresholds, ...cascade })'));
  const base: any = (await import('../src/registry/universes.ts')).resolveUniverseManifest('NWCH');
  for (const manifest of [{ ...base, reviewCascade: { enabled: true } }, base]) {
    const offline = candidateReviewFor('NWCH', { offline: true, manifest });
    assert.deepEqual([offline.status, typeof offline.review], ['STAND_IN_OFFLINE', 'function'], 'the offline stand-in builds with and without the cascade');
  }
});

test('C1: preflightModelGateway passes when the gateway answers and fails closed with MODEL_GATEWAY_UNREACHABLE otherwise; wired before the first SQL and skipped without a model', async () => {
  const { preflightModelGateway } = await import('../src/agent/cli-run.ts');
  let pings = 0;
  await preflightModelGateway({ ping: async () => { pings++; } });
  assert.equal(pings, 1);
  await assert.rejects(() => preflightModelGateway({ ping: async () => { throw new SafeError('NETWORK_ERROR'); } }), (error: any) => error.code === 'MODEL_GATEWAY_UNREACHABLE' && /NETWORK_ERROR/.test(error.detail ?? error.message ?? ''));
  const source = fs.readFileSync(new URL('../src/agent/cli-run.ts', import.meta.url), 'utf8');
  const call = source.indexOf('if (nightshift) await preflightModelGateway(nightshift);');
  assert.ok(call > 0 && call < source.indexOf('runAgent(universe, runId, liveAgentDeps'), 'preflight runs before the engine (first SQL)');
  assert.ok(source.indexOf('if (options.model) {') < call, 'only built when the model is requested (--no-model builds no client)');
});
