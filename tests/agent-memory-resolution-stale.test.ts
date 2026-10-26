import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_MEMORY_ACTOR } from '../src/agent/memory.ts';
import { Reconciler } from '../src/reconcile/index.ts';
import { ROOT } from '../src/runtime.ts';

/** N24: a human resolution makes STALE what depends on the losing alternative; the winner's dependents stay intact; decisionHistory records it. */
const made: string[] = [];
const scratch = () => { const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')); made.push(dir); return path.join(dir, 'LOCAL-SYNTHETIC'); };
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const mk = (entity: string, value: string, source: string) => ({ entity, attribute: 'attr', value, source, confidence: 0.8, requestIds: [source], sourceVersion: 'v', observedAt: '2026-10-25T00:00:00Z', rule: 'x', runId: 'r1' });

function setup() {
  const r = new Reconciler('AGENTFX', scratch(), AGENT_MEMORY_ACTOR);
  const a = r.addClaim(mk('U:e', 'A', 's1')), b = r.addClaim(mk('U:e', 'B', 's2'));
  const onA = r.addClaim(mk('U:onA', 'x', 's3'), false, [a.id]), onB = r.addClaim(mk('U:onB', 'y', 's4'), false, [b.id]), deepB = r.addClaim(mk('U:deepB', 'z', 's5'), false, [onB.id]);
  r.detect();
  const conflict = r.conflicts.find(c => c.claimIds.includes(a.id) && c.claimIds.includes(b.id))!;
  return { r, a, b, onA, onB, deepB, conflict };
}
const claim = (r: Reconciler, id: string) => r.claims.find(c => c.id === id)!;

test('N24: the dependents of the losing alternative (transitively) become STALE with the resolution as the reason; the winner\'s dependents stay intact', () => {
  const { r, a, onA, onB, deepB, conflict } = setup();
  r.resolve(conflict.id, a.id, true, 'choose A', conflict.version);
  for (const id of [onB.id, deepB.id]) {
    const c = claim(r, id);
    assert.ok(c.staleAt !== undefined, id);
    assert.match(c.staleReason!, /superseded_by_human_resolution/);
    assert.ok(c.staleReason!.includes(conflict.id), 'carries the resolution id');
  }
  assert.equal(claim(r, onA.id).staleAt, undefined, 'a dependent of the winner stays intact');
  assert.equal(claim(r, a.id).staleAt, undefined);
});

test('N24: the human correction itself is not made stale, and decisionHistory records the stale dependents', () => {
  const { r, a, onB, deepB, conflict } = setup();
  r.resolve(conflict.id, a.id, true, 'choose A', conflict.version);
  const resolved = r.conflicts.find(c => c.id === conflict.id)!, last = resolved.decisionHistory![resolved.decisionHistory!.length - 1]!;
  assert.ok(last.correction && claim(r, last.correction).staleAt === undefined, 'the correction is not stale');
  assert.deepEqual([...last.staleDependents!].sort(), [onB.id, deepB.id].sort());
  const ledger = r.hmem.ledger.all().filter((entry: any) => entry.details?.event === 'claim_stale_by_derivation');
  assert.ok(ledger.length >= 2);
});

test('N24: an automatic resolution does not mark dependents (human decisions only)', () => {
  const { r, a, onB, conflict } = setup();
  r.resolve(conflict.id, a.id, false, 'auto', conflict.version);
  assert.equal(claim(r, onB.id).staleAt, undefined);
});
