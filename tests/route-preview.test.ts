import test from 'node:test';
import assert from 'node:assert/strict';
import { eligiblePreview, receiptSnapshot } from '../src/route-preview.ts';
test('preview accepts Anthropic Haiku/Sonnet but rejects wrong provider, coercion, Opus/Fable or catalog-only presence', () => {
  const p = { http: 200, payload: { mode: 'cheap' }, bound_mode: 'cheap', routed_mode: 'cheap', mode_coerced: false, raced: ['claude-haiku-fixture'], candidates: [{ id: 'claude-haiku-fixture', provider: 'anthropic' }] };
  assert.equal(eligiblePreview(p), true);
  assert.equal(eligiblePreview({ ...p, bound_mode: 'auto' }), false);
  assert.equal(eligiblePreview({ ...p, routed_mode: 'fast' }), false);
  assert.equal(eligiblePreview({ ...p, mode_coerced: true }), false);
  assert.equal(eligiblePreview({ ...p, http: 404 }), false);
  assert.equal(eligiblePreview({ ...p, candidates: [{ id: 'claude-opus-fixture', provider: 'anthropic' }] }), false);
  assert.equal(eligiblePreview({ ...p, candidates: [{ id: 'claude-haiku-fixture', provider: 'other' }] }), false);
  assert.equal(eligiblePreview({ ...p, raced: ['nvidia/fixture'] }), false);
  assert.equal(eligiblePreview({ ...p, raced: ['claude-haiku-fixture','claude-opus-fixture'] }), false);
  assert.equal(eligiblePreview({ ...p, raced: [] }), false);
  assert.equal(eligiblePreview({ ...p, raced: ['claude-sonnet-fixture'], candidates: [{ id: 'claude-sonnet-fixture', provider: 'anthropic' }] }), true);
  assert.equal(eligiblePreview({ ...p, raced: ['claude-fable-fixture'], candidates: [{ id: 'claude-fable-fixture', provider: 'anthropic' }] }), false);
});
test('receipt comparison preserves failed request identity without prompt data', () => {
  const snapshot = receiptSnapshot({ data: [{ body: { receipt: { request_id: 'failed-fixture', app: 'concordia', status: 'failed', prompt_preview: 'exclude this' } } }] });
  assert.equal(snapshot[0].request_id, 'failed-fixture');
  assert.equal('prompt_preview' in snapshot[0], false);
});
