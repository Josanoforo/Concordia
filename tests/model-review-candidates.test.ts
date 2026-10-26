import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { reviewBlindCandidates } from '../src/agent/model-review/candidates.ts';
import { reviewEligibility } from '../src/agent/model-review/evidence.ts';
import { standInAdversary, standInJudge } from '../src/agent/model-review/standin.ts';
import { RunBudget } from '../src/agent/run-budget.ts';
import { loadF04Set, MIN_DISTINCT_KEYS } from './helpers/model-review-f04.ts';

const defaults = { universeId: 'TPCDS', database: 'TPCDS_DB', normalization: 'text', normalizationVersion: 'text-exact-v1', normalizationAdapterCapability: 'exact-text' };
const review = async (over: object = {}) => {
  const set = loadF04Set();
  const budget = new RunBudget({ maxQueriesPerRun: 5, readLimit: 50, maxTokensPerRun: 1_000_000, maxSteps: 3 });
  const result = await reviewBlindCandidates({ proposals: set.proposals, universeId: 'TPCDS', context: { minDistinctKeys: MIN_DISTINCT_KEYS, negativeControl: undefined }, judges: [standInJudge('j1', 'SEMANTIC'), standInJudge('j2', 'SEMANTIC')],
    adversary: standInAdversary('adv'), budget, config: { minDistinctKeys: MIN_DISTINCT_KEYS }, defaults, allowStandIn: true, now: () => '2026-10-26T00:00:00.000Z', ...over });
  return { set, result, budget };
};
const humanYes = () => JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'universes', 'reviews', 'TPCDS.review.json'), 'utf8')).relations as any[];

test('R-1: only probed, HIGH-coverage, unsuspected candidates are reviewed; the rest are recorded with the reason, never sent to a model', async () => {
  const { set, result } = await review();
  const eligible = set.proposals.filter(item => reviewEligibility(item).eligible);
  assert.equal(eligible.length, 30, '28 of live-04 without suspicion + 2 decoys with HIGH coverage; ss_promo_sk -> reason has LOW coverage and is not sent');
  assert.equal(result.run.reviews.length, 30);
  assert.deepEqual(result.overlay.notApproved.find(item => item.relationId === 'store_sales.ss_promo_sk__reason.r_reason_sk'), { relationId: 'store_sales.ss_promo_sk__reason.r_reason_sk', decision: 'defer', reasons: ['COVERAGE_LOW'], reviewed: false });
  const catalogPage = result.overlay.notApproved.filter(item => /catalog_page\.cp_catalog_page_sk$/.test(item.relationId));
  assert.equal(catalogPage.length, 2); assert.ok(catalogPage.every(item => !item.reviewed && item.reasons[0]!.startsWith('SUSPECT:') && item.reasons[0]!.includes('TARGET_NOT_UNIQUE')));
  assert.ok(result.overlay.notApproved.some(item => !item.reviewed && item.reasons[0] === 'NO_SAFE_SAMPLED_VALUES'));
  assert.equal(result.overlay.counts.candidates, set.proposals.length);
});

test('R-1: the approved candidates are exactly the human YES set, as MODEL_REVIEWED contracts with the fields the human overlay carries; deferred and decoys get none', async () => {
  const { result } = await review();
  const yes = humanYes();
  assert.deepEqual(result.contracts.map(item => item.id).sort(), yes.map(item => item.id).sort(), '25/25 approved, 0 extra');
  assert.equal(result.overlay.counts.approved, 25); assert.equal(result.overlay.origin, 'MODEL_REVIEW');
  for (const id of ['inventory.inv_warehouse_sk__warehouse.w_warehouse_sk', 'inventory.inv_date_sk__date_dim.d_date_sk', 'catalog_page.cp_end_date_sk__date_dim.d_date_sk', 'store_sales.ss_store_sk__web_site.web_site_sk', 'inventory.inv_warehouse_sk__ship_mode.sm_ship_mode_sk', 'store_sales.ss_promo_sk__reason.r_reason_sk'])
    assert.ok(!result.contracts.some(item => item.id === id) && result.overlay.notApproved.some(item => item.relationId === id && item.decision !== 'accept'), id);
  for (const contract of result.contracts) {
    const human = yes.find(item => item.id === contract.id);
    for (const key of ['kind', 'reviewState', 'normalization', 'normalizationVersion', 'normalizationLossless', 'normalizationAdapterCapability']) assert.deepEqual((contract as any)[key], human[key], `${contract.id}.${key}`);
    assert.deepEqual(contract.from, human.from); assert.deepEqual(contract.to, human.to);
    assert.equal(contract.reviewOrigin, 'MODEL_REVIEWED');
  }
  // identifierSpace partitions the relations like the human one does (one space per target).
  const group = (pick: (item: any) => string) => { const map = new Map<string, string[]>(); for (const item of result.contracts) { const key = pick(item); map.set(key, [...(map.get(key) ?? []), item.id]); } return [...map.values()].map(ids => ids.sort().join('|')).sort(); };
  const humanById = new Map(yes.map(item => [item.id, item]));
  assert.deepEqual(group(item => item.identifierSpace), group(item => humanById.get(item.id).identifierSpace));
});

test('R-1: without allowStandIn a stand-in run yields no contract; the overlay never claims a human origin and states the limits', async () => {
  const { result } = await review({ allowStandIn: false });
  assert.deepEqual(result.contracts, []); assert.equal(result.overlay.relations.length, 0); assert.equal(result.overlay.provenance, 'STAND_IN_OFFLINE');
  const { result: offline } = await review();
  const text = JSON.stringify(offline.overlay);
  assert.equal(text.includes('HUMAN_REVIEW'), false); assert.doesNotMatch(text, /validad|validated/i);
  assert.ok(offline.overlay.limitations.some(item => item.includes('never where HUMAN is required')));
  for (const relation of offline.overlay.relations) { assert.equal(relation.label, 'revisado por modelo con pase adversarial'); assert.ok(relation.review.promptHashes.length >= 3); assert.ok(relation.review.promptHashes.every(hash => /^[0-9a-f]{64}$/.test(hash))); }
});

test('R-1: a candidate the homonym guard flagged is not reviewed by default (no contract)', async () => {
  const set = loadF04Set();
  const flagged = structuredClone(set.proposals);
  const target = flagged.find(item => item.proposalId === 'store_sales.ss_store_sk__store.s_store_sk')!;
  (target.coverageProbe!.diagnostic as any).suspect = { value: true, reasons: ['COMPETING_TARGET'], preferredTarget: 'x' };
  const { result } = await review({ proposals: flagged });
  assert.ok(!result.contracts.some(item => item.id === target.proposalId));
  assert.deepEqual(result.overlay.notApproved.find(item => item.relationId === target.proposalId), { relationId: target.proposalId, decision: 'defer', reasons: ['SUSPECT:COMPETING_TARGET'], reviewed: false });
});
