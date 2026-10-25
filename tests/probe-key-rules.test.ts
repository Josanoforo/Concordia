import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateKeyRules } from '../src/probe/key-rules.ts';

const rows = (...keys: (string | null)[]) => keys.map(key => [key]);

test('E-03: inclusion holds while the target is not unique: the two rules are independent', () => {
  const r = evaluateKeyRules(rows('1', '2'), rows('1', '1', '2'), 'integer', { targetBounded: false });
  assert.equal(r.inclusion.status, 'NO_VIOLATION_IN_SAMPLE');
  assert.equal(r.targetUniqueness.status, 'DUPLICATES_OBSERVED');
  assert.deepEqual({ dup: r.targetUniqueness.duplicateKeyCount, max: r.targetUniqueness.maxRowsPerKey }, { dup: 1, max: 2 });
});

test('E-03: a unique target can still violate inclusion', () => {
  const r = evaluateKeyRules(rows('1', '2', '3'), rows('1', '2'), 'integer', { targetBounded: false });
  assert.equal(r.targetUniqueness.status, 'NO_DUPLICATES_IN_SAMPLE');
  assert.equal(r.inclusion.status, 'VIOLATED_IN_SAMPLE');
  assert.deepEqual(r.inclusion.missingKeys, ['3']);
});

test('E-03: absence in a truncated target is not a violation, but observed duplicates still count', () => {
  const r = evaluateKeyRules(rows('1', '9'), rows('1', '1'), 'integer', { targetBounded: true });
  assert.equal(r.inclusion.status, 'UNKNOWN');
  assert.equal(r.inclusion.reason, 'TARGET_TRUNCATED_ABSENCE_NOT_RELIABLE');
  assert.equal(r.targetUniqueness.status, 'DUPLICATES_OBSERVED');
});

test('E-03: empty or null-only samples are UNKNOWN, never satisfied; normalization applies to both rules', () => {
  const none = evaluateKeyRules(rows(null), rows(''), 'integer', { targetBounded: false });
  assert.equal(none.inclusion.status, 'UNKNOWN');
  assert.equal(none.targetUniqueness.status, 'UNKNOWN');
  const norm = evaluateKeyRules(rows('1'), rows('1', '1.0'), 'integer', { targetBounded: false });
  assert.equal(norm.targetUniqueness.status, 'DUPLICATES_OBSERVED');
  assert.equal(evaluateKeyRules(rows('1'), rows('1', '1.0'), 'text', { targetBounded: false }).targetUniqueness.status, 'NO_DUPLICATES_IN_SAMPLE');
});
