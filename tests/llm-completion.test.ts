import test from 'node:test';
import assert from 'node:assert/strict';
import { attachExplanations, mergeProposals, parseModelJson } from '../src/llm-completion.ts';
import { universe } from '../src/universe.ts';
test('model proposals cannot inject unknown SQL identifiers or sensitive columns', () => {
  const receipt: any = { receiptId: 'fixture' };
  const d: any = { candidates: [] };
  const body = { proposals: [
    { from: { table: 'trips', column: 'customer_id' }, to: { table: 'zones', column: 'zone_id' }, reason: 'should reject excluded key' },
    { from: { table: 'x;DROP', column: 'id' }, to: { table: 'zones', column: 'zone_id' }, reason: 'should reject injection' },
    { from: { table: 'trips', column: 'pickup_zone_id' }, to: { table: 'zones', column: 'zone_id' }, reason: 'candidate only, needs probes' }
  ] };
  const merged = mergeProposals(d, body, receipt, universe());
  assert.equal(merged.rejected.length, 2); assert.equal(merged.addedIds.length, 1);
  assert.equal(merged.candidates[0].proposedBy, 'llm');
  const dedup = mergeProposals({ ...d, candidates: merged.candidates }, { proposals: [body.proposals[2]] }, receipt, universe());
  assert.equal(dedup.candidates.length, 1); assert.equal(dedup.addedIds.length, 0);
});
test('editorial model cannot change mechanical verdicts, metrics or SQL and must cover every id', () => {
  const original: any = { pending_llm: true, relations: [{ relationId: 'fixture', verdict: 'ENGAÑOSA', evidence: { overlap: { matched: 3 }, queries: ['original'] }, explanation: 'deterministic' }] };
  const output = attachExplanations(original, { explanations: [{ relationId: 'fixture', explanation: 'Las etiquetas contradicen la identidad propuesta.', verdict: 'SOSTENIDA', evidence: {} }] }, { receiptId: 'fixture-receipt' } as any);
  assert.equal(output.relations[0].verdict, 'ENGAÑOSA');
  assert.deepEqual(output.relations[0].evidence, original.relations[0].evidence);
  assert.equal(output.pending_llm, false); assert.equal(original.pending_llm, true);
  assert.throws(() => attachExplanations(original, { explanations: [] }, {} as any));
  assert.throws(() => parseModelJson('not JSON'));
});
