import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewModeOf } from '../src/agent/engine.ts';

/** R-config as the engine reads it: relation > manifest per-relation > manifest universe > HUMAN; an unknown relation value fails closed. */
test('R-config: relation > manifest per-relation > manifest universe > HUMAN; an unknown relation value fails closed', () => {
  assert.equal(reviewModeOf({ manifest: { reviewMode: 'BOTH' } }, { id: 'a' }), 'BOTH');
  assert.equal(reviewModeOf({ manifest: { reviewMode: 'BOTH' } }, { id: 'a', reviewMode: 'HUMAN' }), 'HUMAN');
  assert.equal(reviewModeOf({ manifest: { reviewMode: 'BOTH', reviewModeByRelation: { a: 'MODEL_ADVERSARIAL' } } }, { id: 'a' }), 'MODEL_ADVERSARIAL');
  assert.equal(reviewModeOf({}, { id: 'a' }), 'HUMAN');
  assert.throws(() => reviewModeOf({}, { id: 'a', reviewMode: 'ROBOT' }), /REVIEW_MODE_INVALID/);
});
