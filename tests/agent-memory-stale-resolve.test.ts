import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_MEMORY_ACTOR, memoryReport } from '../src/agent/memory.ts';
import { Reconciler } from '../src/reconcile/index.ts';
import { ROOT } from '../src/runtime.ts';

/** M8-2: a human closes a STALE claim, by API: CONFIRM (new observation, human reviewer) or INVALIDATE; one ledger entry; it leaves the queue. */
const made: string[] = [];
const scratch = () => { const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')); made.push(dir); return path.join(dir, 'LOCAL-SYNTHETIC'); };
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const mk = (entity: string, value: string) => ({ entity, attribute: 'status', value, source: 's:' + entity, confidence: 0.9, requestIds: ['q'], sourceVersion: 'v', observedAt: '2026-10-25T00:00:00Z', rule: 'x', runId: 'r1' });
const staleSetup = () => {
  const r = new Reconciler('AGENTFX', scratch(), AGENT_MEMORY_ACTOR);
  const base = r.addClaim(mk('relation:a', 'SOSTENIDA')), child = r.addClaim(mk('relation:b', 'INDETERMINADA'), false, [base.id]), grand = r.addClaim(mk('relation:c', 'INDETERMINADA'), false, [child.id]);
  r.invalidate(base.id, 'root cause');
  return { r, base, child, grand };
};
const queue = (r: Reconciler) => (memoryReport(r, 'r1', 'x').reviewQueue as any[]).filter(item => item.kind === 'STALE_DEPENDENCY').map(item => item.claimId);

test('M8-2 resolveStale CONFIRM: a human re-affirms with a newer observation; the claim is believed again and leaves the queue; one ledger entry', () => {
  const { r, child, grand } = staleSetup();
  assert.deepEqual(queue(r).sort(), [child.id, grand.id].sort());
  const before = [...r.hmem.ledger.all()].length;
  const result = r.resolveStale(child.id, 'CONFIRM', 'jonas', { observedAt: new Date().toISOString(), note: 'checked by hand' });
  assert.equal(result.confirmed, true);
  const claim = r.claims.find(c => c.id === child.id)!;
  assert.deepEqual([claim.staleAt, claim.staleBy, claim.staleReason], [undefined, undefined, undefined]);
  assert.deepEqual([claim.staleResolution?.decision, claim.staleResolution?.reviewer], ['CONFIRM', 'jonas']);
  assert.deepEqual(queue(r), [grand.id], 'only the confirmed one left the queue');
  const added = [...r.hmem.ledger.all()].slice(before);
  assert.equal(added.length, 1); assert.equal((added[0] as any).details.event, 'stale_confirmed'); assert.equal((added[0] as any).actor, 'jonas');
  assert.ok(r.believedAt(new Date().toISOString()).claims.some(c => c.id === child.id));
  assert.throws(() => r.resolveStale(child.id, 'CONFIRM', 'jonas', { observedAt: new Date().toISOString() }), /CLAIM_NOT_STALE/, 'a second resolution is refused');
});

test('M8-2 resolveStale INVALIDATE: the stale claim is invalidated, leaves the queue, and its own dependents stay stale', () => {
  const { r, child, grand } = staleSetup();
  const result = r.resolveStale(child.id, 'INVALIDATE', 'jonas', { note: 'wrong' });
  assert.deepEqual(result.decision, 'INVALIDATE');
  assert.ok(r.claims.find(c => c.id === child.id)!.invalidatedAt);
  assert.deepEqual(queue(r), [grand.id]);
  assert.equal(r.claims.find(c => c.id === child.id)!.staleResolution?.reviewer, 'jonas');
});

test('M8-2 resolveStale refusals: not stale, unknown claim, no human reviewer, the facade actor, stale or future or missing observation', () => {
  const { r, base, child } = staleSetup(), now = new Date().toISOString();
  assert.throws(() => r.resolveStale('nope', 'CONFIRM', 'jonas', { observedAt: now }), /CLAIM_NOT_FOUND/);
  assert.throws(() => r.resolveStale(base.id, 'CONFIRM', 'jonas', { observedAt: now }), /CLAIM_NOT_STALE/, 'the invalidated root is not stale');
  assert.throws(() => r.resolveStale(child.id, 'CONFIRM', '', { observedAt: now }), /HUMAN_REVIEWER_REQUIRED/);
  assert.throws(() => r.resolveStale(child.id, 'CONFIRM', AGENT_MEMORY_ACTOR, { observedAt: now }), /HUMAN_REVIEWER_REQUIRED/);
  assert.throws(() => r.resolveStale(child.id, 'CONFIRM', 'jonas', {}), /CONFIRM_REQUIRES_OBSERVED_AT/);
  assert.throws(() => r.resolveStale(child.id, 'CONFIRM', 'jonas', { observedAt: '2027-01-01T00:00:00Z' }), /CONFIRM_OBSERVED_AT_IN_FUTURE/);
  assert.throws(() => r.resolveStale(child.id, 'CONFIRM', 'jonas', { observedAt: '2026-10-25T00:00:00Z' }), /CONFIRM_REQUIRES_NEWER_OBSERVATION/);
  assert.equal(queue(r).includes(child.id), true, 'every refusal left the queue untouched');
});

test('M8-2 resolveStale is durable: reopening the scope keeps the resolution and the smaller queue', () => {
  const { r, child, grand } = staleSetup();
  r.resolveStale(child.id, 'CONFIRM', 'jonas', { observedAt: new Date().toISOString() });
  const reopened = new Reconciler('AGENTFX', (r as any).scope, AGENT_MEMORY_ACTOR);
  assert.equal(reopened.claims.find(c => c.id === child.id)!.staleResolution?.decision, 'CONFIRM');
  assert.deepEqual(queue(reopened), [grand.id]);
});
