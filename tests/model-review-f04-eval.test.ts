import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIGURATIONS, evaluateConfiguration } from '../scripts/model-review-eval.ts';
import { labelledPackets, loadF04Set } from './helpers/model-review-f04.ts';

const configuration = (prefix: string) => CONFIGURATIONS.find(item => item.name.startsWith(prefix))!;

test('F-04 label set: 25 YES, 3 DEFERRED, 3 decoys, 2 catalog_page; the YES ids are exactly the approved contract', () => {
  const { labels } = loadF04Set();
  const count = (label: string) => labels.filter(item => item.label === label).length;
  assert.deepEqual([count('YES'), count('DEFERRED'), count('DECOY'), count('NOT_OFFERED')], [25, 3, 3, 2]);
  const overlay = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'universes', 'reviews', 'TPCDS.review.json'), 'utf8'));
  assert.deepEqual(labels.filter(item => item.label === 'YES').map(item => item.relationId).sort(), overlay.relations.map((item: { id: string }) => item.id).sort());
  assert.equal(new Set(labels.map(item => item.relationId)).size, labels.length);
  const packetIds = new Set(labelledPackets(loadF04Set()).map(packet => packet.relationId));
  for (const { relationId } of labels) assert.ok(packetIds.has(relationId), `${relationId} has a packet`);
});

test('default configuration (semantic judges + adversarial pass) agrees with F-04: 25/25 accepted, 3/3 deferred, 3/3 decoys not accepted, 0 false accepts', async () => {
  const { run, report } = await evaluateConfiguration(configuration('D.'));
  assert.equal(report.provenance, 'STAND_IN_OFFLINE', 'a stand-in measurement says so');
  assert.deepEqual([report.classes.YES.exact, report.classes.YES.n], [25, 25]);
  assert.deepEqual([report.classes.DEFERRED.exact, report.classes.DEFERRED.n], [3, 3]);
  assert.deepEqual([report.classes.DECOY.acceptable, report.classes.DECOY.n], [3, 3]);
  assert.deepEqual([report.classes.NOT_OFFERED.acceptable, report.classes.NOT_OFFERED.n], [2, 2]);
  assert.deepEqual(report.falseAccepts, []); assert.deepEqual(report.missedAccepts, []); assert.deepEqual(report.withoutReview, []);
  assert.deepEqual([report.overall.acceptable, report.overall.n], [31, 31]);
  for (const review of run.reviews) { assert.equal(review.origin, 'MODEL_REVIEWED'); assert.equal(review.humanReviewed, false); }
  // Each decoy must come out reject or defer, and the three named in the F-04 conditions are the ones checked.
  for (const id of ['store_sales.ss_store_sk__web_site.web_site_sk', 'inventory.inv_warehouse_sk__ship_mode.sm_ship_mode_sk', 'store_sales.ss_promo_sk__reason.r_reason_sk']) assert.notEqual(run.reviews.find(review => review.relationId === id)!.decision, 'accept', id);
  // The "at the minimum of 3 keys" relations keep their F-04 annotation: medium confidence and the weak-evidence reason.
  for (const id of ['store_sales.ss_store_sk__store.s_store_sk', 'catalog_returns.cr_call_center_sk__call_center.cc_call_center_sk', 'catalog_sales.cs_call_center_sk__call_center.cc_call_center_sk']) {
    const review = run.reviews.find(item => item.relationId === id)!;
    assert.equal(review.decision, 'accept'); assert.equal(review.confidence, 'medium'); assert.ok(review.reasons.includes('AT_MINIMUM_KEYS'));
  }
});

test('ablation: evidence-only judges accept the homonym (the live negative-control finding); the adversarial pass is what stops it', async () => {
  const a = await evaluateConfiguration(configuration('A.')), b = await evaluateConfiguration(configuration('B.')), c = await evaluateConfiguration(configuration('C.'));
  assert.deepEqual(a.report.falseAccepts, [{ relationId: 'store_sales.ss_store_sk__web_site.web_site_sk', label: 'DECOY' }]);
  assert.deepEqual(b.report.falseAccepts, [], 'adversarial pass on top of evidence-only judges');
  assert.deepEqual(c.report.falseAccepts, [], 'semantic judges alone');
  assert.equal(a.report.classes.YES.exact, 25, 'the lenient configuration is not stricter: it accepts all 25 too');
});

test('the run is complete and traceable: every evaluation and attack of the default configuration is in the trace', async () => {
  const { run } = await evaluateConfiguration(configuration('D.'));
  assert.equal(run.status, 'COMPLETE');
  const evaluated = run.reviews.filter(review => review.evaluations.length);
  const trace = run.trace.filter(event => event.kind === 'model-review-call' && event.callStatus);
  assert.equal(trace.filter(event => event.stage === 'EVALUATION').length, evaluated.length * 2);
  assert.equal(trace.filter(event => event.stage === 'ATTACK').length, run.counts.adversarialCompleted);
  assert.equal(run.counts.adversarialCompleted, 25);
  assert.equal(run.counts.calls, trace.length);
  assert.ok(run.notEvaluated.length > 50);
  for (const review of run.reviews.filter(item => item.decision === 'accept')) {
    assert.equal(review.adversary.attacks.length, 4); assert.equal(review.attacksSustained.length, 0);
    assert.equal(review.attacksSurvived.length + review.adversary.attacks.filter(a => a.outcome === 'NO_ATTACK').length, 4);
  }
});
