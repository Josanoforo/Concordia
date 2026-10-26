import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluationLabels, loadF04ReviewLabels, unlabelledCandidates } from '../src/eval/f04-review-labels.ts';
import { ROOT } from '../src/runtime.ts';

/** Round 9: the F-04 human labels as an offline evaluation set for the model reviewer. Human evaluation, never a runtime input. */
const set = loadF04ReviewLabels(), overlay = JSON.parse(fs.readFileSync(path.join(ROOT, 'universes', 'reviews', 'TPCDS.review.json'), 'utf8'));

test('the set is the F-04 review: 25 YES = the overlay relations, 3 DEFERRED = the overlay deferred, 3 DECOY outside the contract; labelled as human evaluation', () => {
  assert.deepEqual([set.kind, set.universe, set.evaluationOnly], ['F04_REVIEW_EVALUATION_LABELS', 'TPCDS', true]);
  assert.match(set.labelling, /evaluación humana/); assert.match(set.labelling, /nunca una entrada de runtime/);
  assert.deepEqual(set.approval, { approver: overlay.approval.approver, approvedAt: overlay.approval.approvedAt, quote: overlay.approval.quote, session: overlay.approval.session }, 'same verbatim approval as the overlay');
  const byLabel = (label: string) => set.labels.filter(item => item.label === label).map(item => item.relationId).sort();
  assert.deepEqual(set.counts, { YES: 25, DEFERRED: 3, DECOY: 3 });
  assert.deepEqual(byLabel('YES'), overlay.relations.map((r: any) => r.id).sort());
  assert.deepEqual(byLabel('DEFERRED'), overlay.deferred.map((r: any) => r.id).sort());
  assert.equal(byLabel('DECOY').length, 3);
  const ids = set.labels.map(item => item.relationId); assert.equal(new Set(ids).size, 31, 'no relation carries two labels');
});

test('the endpoints are consistent with the relation id, and no decoy is a contract relation or a deferred one', () => {
  for (const item of set.labels) assert.equal(item.relationId, `${item.from.table}.${item.from.column}__${item.to.table}.${item.to.column}`, item.relationId);
  const contract = new Set(overlay.relations.map((r: any) => `${r.from.table}.${r.from.column}>${r.to.table}.${r.to.column}`));
  for (const decoy of set.labels.filter(item => item.label === 'DECOY')) assert.ok(!contract.has(`${decoy.from.table}.${decoy.from.column}>${decoy.to.table}.${decoy.to.column}`), decoy.relationId);
});

test('the candidate list handed to a reviewer carries no label, and the evaluation labels carry no evidence', () => {
  for (const candidate of unlabelledCandidates(set)) assert.deepEqual(Object.keys(candidate).sort(), ['from', 'relationId', 'to']);
  for (const item of evaluationLabels(set)) assert.deepEqual(Object.keys(item).sort(), ['label', 'relationId']);
  assert.equal(unlabelledCandidates(set).length, 31);
});

test('no runtime module can read the labels: only src/eval and the reviewer evaluation (which takes them as an argument) may name them', () => {
  const dirs = ['agent', 'probe', 'discovery', 'registry', 'relations', 'critic', 'reconcile', 'report', 'export', 'clients'];
  for (const dir of dirs) {
    const root = path.join(ROOT, 'src', dir);
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root, { recursive: true })) {
      const file = path.join(root, String(name));
      if (!file.endsWith('.ts') || !fs.statSync(file).isFile()) continue;
      assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /f04-review-labels|F04_REVIEW_EVALUATION_LABELS|TPCDS_f04_review_labels/, path.relative(ROOT, file));
    }
  }
});
