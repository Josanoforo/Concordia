import test from 'node:test';
import assert from 'node:assert/strict';
import { createDependencyRef, type EvidenceValidity } from '../src/reconcile/freshness.ts';
import { measureFreshnessConditions } from '../src/reconcile/freshness-measure.ts';

const NOW = Date.parse('2026-10-25T12:00:00Z');
const validity = (over: Partial<EvidenceValidity> = {}): EvidenceValidity => ({ observedAt: null, checkedAt: '2026-10-25T11:00:00Z', sourceToken: 'tok-1', sourceFingerprint: 'fp-1', schemaFingerprint: 's1', contractFingerprint: 'c1',
  normalizationFingerprint: 'n1', completeness: 'COMPLETE', requestIds: [], state: 'CURRENT_FOR_CHECK', requiresReview: false, ...over });
const deps = (id: string) => [createDependencyRef(`${id}:decision`, 'decision', [id], 'v1'), createDependencyRef(`${id}:output`, 'output', [`${id}:decision`], 'v1'), createDependencyRef('other:decision', 'decision', ['other'], 'v1')];
const relations = [
  { relationId: 'r1', reads: 2, baseline: validity(), alteration: { sourceToken: 'tok-2' }, dependencies: deps('r1') },
  { relationId: 'r2', reads: 3, baseline: validity({ sourceToken: null, sourceFingerprint: 'fp-2' }), alteration: { normalizationFingerprint: 'n2' }, dependencies: deps('r2') },
];

test('E-10: cold runs every probe; hot unchanged saves them all; hot altered saves none and invalidates dependents', () => {
  const m = measureFreshnessConditions(relations, { now: NOW, ttlMs: 2 * 3600_000 });
  assert.deepEqual({ ex: m.conditions.COLD.probesExecuted, q: m.conditions.COLD.queriesExecuted, saved: m.conditions.COLD.probesSaved }, { ex: 2, q: 5, saved: 0 });
  assert.deepEqual({ ex: m.conditions.HOT_UNCHANGED.probesExecuted, saved: m.conditions.HOT_UNCHANGED.probesSaved, qs: m.conditions.HOT_UNCHANGED.queriesSaved, reused: m.conditions.HOT_UNCHANGED.evidenceReused }, { ex: 0, saved: 2, qs: 5, reused: 2 });
  assert.deepEqual({ ex: m.conditions.HOT_ALTERED.probesExecuted, saved: m.conditions.HOT_ALTERED.probesSaved, invalid: m.conditions.HOT_ALTERED.evidenceInvalidated, reprobed: m.conditions.HOT_ALTERED.reprobed }, { ex: 2, saved: 0, invalid: 4, reprobed: ['r1', 'r2'] });
  assert.deepEqual(m.undetectedAlterations, []);
});

test('E-10: an expired baseline is re-probed even when nothing changed, and an alteration that changes no version is flagged', () => {
  const m = measureFreshnessConditions([{ ...relations[0], alteration: {} }], { now: NOW, ttlMs: 60_000 });
  assert.equal(m.conditions.HOT_UNCHANGED.probesSaved, 0);
  assert.equal(m.conditions.HOT_UNCHANGED.probesExecuted, 1);
  assert.deepEqual(m.undetectedAlterations, ['r1']);
  assert.equal(m.conditions.HOT_ALTERED.evidenceInvalidated, 0);
});

test('E-10: incomplete baselines are never reused', () => {
  const m = measureFreshnessConditions([{ ...relations[0], baseline: validity({ completeness: 'TRUNCATED', state: 'INCOMPLETE' }) }], { now: NOW });
  assert.equal(m.conditions.HOT_UNCHANGED.probesSaved, 0);
  assert.equal(m.conditions.HOT_UNCHANGED.evidenceReused, 0);
});
