import test from 'node:test';
import assert from 'node:assert/strict';
import { measureContainment } from '../src/probe/index.ts';

const rows = (...keys: (string | null)[]) => keys.map(key => [key]);

test('E-02: independent samples report C(A->B), C(B->A) and Jaccard over distinct normalized keys', () => {
  const c = measureContainment(rows('1', '1', '2', '3', null), 0, rows('2', '3', '3', '4', '5', '6'), 0, 'integer', { targetFilteredBySource: false });
  assert.deepEqual(c.aToB, { shared: 2, of: 3, ratio: 2 / 3 });
  assert.deepEqual(c.bToA, { shared: 2, of: 5, ratio: 2 / 5 });
  assert.equal(c.jaccard, 2 / 6);
  assert.deepEqual({ a: c.distinctFrom, b: c.distinctTo, comparable: c.comparable }, { a: 3, b: 5, comparable: true });
});

test('E-02: normalization decides what is shared (1 and 1.0 are one key)', () => {
  const c = measureContainment(rows('1.0', '2'), 0, rows('1', '3'), 0, 'integer', { targetFilteredBySource: false });
  assert.equal(c.sharedKeys, 1);
  assert.equal(measureContainment(rows('1.0'), 0, rows('1'), 0, 'text', { targetFilteredBySource: false }).sharedKeys, 0);
});

test('E-02: when the target was fetched by the source keys the inverse and Jaccard are not computed', () => {
  const c = measureContainment(rows('1', '2', '3'), 0, rows('1', '2'), 0, 'integer', { targetFilteredBySource: true });
  assert.deepEqual(c.aToB, { shared: 2, of: 3, ratio: 2 / 3 });
  assert.equal(c.bToA, null);
  assert.equal(c.jaccard, null);
  assert.deepEqual({ comparable: c.comparable, reason: c.reason }, { comparable: false, reason: 'TARGET_FILTERED_BY_SOURCE_KEYS' });
});

test('E-02: empty samples give null ratios, never full containment', () => {
  const c = measureContainment([], 0, [], 0, 'integer', { targetFilteredBySource: false });
  assert.equal(c.aToB.ratio, null);
  assert.equal(c.bToA!.ratio, null);
  assert.equal(c.jaccard, null);
});
