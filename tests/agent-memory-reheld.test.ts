import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AGENT_MEMORY_ACTOR, planWarmStart } from '../src/agent/memory.ts';
import { Reconciler } from '../src/reconcile/index.ts';
import { ROOT } from '../src/runtime.ts';

/** N26: after a SOSTENIDA is degraded to INDETERMINADA and a later run holds it again, what does memory say? */
const made: string[] = [];
const scratch = () => { const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')); made.push(dir); return path.join(dir, 'LOCAL-SYNTHETIC'); };
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const origin = { executionMode: 'LOCAL' as const, dataOrigin: 'SYNTHETIC' as const };
const base = { entity: 'relation:r', attribute: 'status', source: 'db.t', confidence: 0.9, requestIds: ['q1'], reviewState: 'REVIEWED', sourceVersion: 'rv1:x', rule: 'bounded_key_overlap' };

test('N26 re-holding: the degraded INDETERMINADA claim must not stay active next to the new SOSTENIDA', () => {
  const dir = scratch(), r = new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR, { strictSustained: true, origin });
  const a = r.addClaim({ ...base, value: 'SOSTENIDA', observedAt: '2026-10-20T00:00:00Z', runId: 'run-1' });
  const b = r.addClaim({ ...base, value: 'INDETERMINADA', confidence: 0, observedAt: '2026-10-21T00:00:00Z', runId: 'run-2', requestIds: ['q2'] }, false, [a.id]);
  r.hmem.store.update(a.id, { supersededBy: b.id }); r.persist();
  const a2 = r.addClaim({ ...base, value: 'SOSTENIDA', observedAt: '2026-10-22T00:00:00Z', runId: 'run-3', requestIds: ['q3'] });
  assert.notEqual(a2.id, a.id, 'a re-held value opens a new claim');
  const active = r.claims.filter(c => c.entity === 'relation:r' && !r.hmem.store.get(c.id)?.supersededBy && c.invalidatedAt === undefined).map(c => c.value);
  assert.deepEqual(active, ['SOSTENIDA'], `active values after re-holding: ${active.join()}`);
  assert.ok(r.hmem.store.get(a.id)?.supersededBy, 'the first claim stays closed');
});
