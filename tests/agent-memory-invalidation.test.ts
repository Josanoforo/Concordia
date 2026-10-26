import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { AGENT_MEMORY_ACTOR, memoryReport, planWarmStart, recordRunMemory } from '../src/agent/memory.ts';
import { Reconciler } from '../src/reconcile/index.ts';
import { ROOT } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

const made: string[] = [];
const scratch = () => { const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')); made.push(dir); return path.join(dir, 'LOCAL-SYNTHETIC'); };
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const claim = (entity: string, value = 'SOSTENIDA') => ({ entity, attribute: 'status', value, source: 's:' + entity, confidence: 0.9, requestIds: ['q-' + entity], sourceVersion: 'v', observedAt: '2026-10-25T00:00:00Z', rule: 'x', runId: 'r1' });

test('R6-M5 / M8-2: invalidating a base claim invalidates only it; every claim derived from it, transitively, becomes STALE with one ledger entry each; unrelated claims stay', () => {
  const dir = scratch(), r = new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR);
  const base = r.addClaim(claim('relation:a')), child = r.addClaim(claim('relation:b', 'INDETERMINADA'), false, [base.id]);
  const grandchild = r.addClaim(claim('relation:c', 'INDETERMINADA'), false, [child.id]), other = r.addClaim(claim('relation:d'));
  const ledgerFile = path.join(dir, 'ledger.jsonl'), ledgerBytesBefore = fs.readFileSync(ledgerFile, 'utf8'), ledgerBefore = [...r.hmem.ledger.all()];
  const result = r.invalidate(base.id, 'source table was replaced');
  assert.deepEqual(result.invalidated, [base.id]);
  assert.deepEqual(result.stale.sort(), [child.id, grandchild.id].sort());
  const byId = (id: string) => r.claims.find(c => c.id === id)!;
  assert.equal(byId(base.id).invalidatedBy, base.id);
  assert.ok([child, grandchild].every(c => byId(c.id).staleAt && byId(c.id).staleBy === base.id && byId(c.id).invalidatedAt === undefined));
  assert.ok([other].every(c => byId(c.id).invalidatedAt === undefined && byId(c.id).staleAt === undefined));
  assert.match(byId(grandchild.id).staleReason!, /derived_from .*source table was replaced/);
  const added = [...r.hmem.ledger.all()].slice(ledgerBefore.length);
  assert.equal(added.length, 3, 'one ledger entry per state change');
  assert.deepEqual(added.map(entry => (entry as any).details?.event).sort(), ['claim_invalidated', 'claim_stale_by_derivation', 'claim_stale_by_derivation']);
  assert.ok(added.every(entry => (entry as any).details.rootClaimId === base.id));
  assert.ok(fs.readFileSync(ledgerFile, 'utf8').startsWith(ledgerBytesBefore), 'the ledger file only appended');
  // durable and idempotent
  const reopened = new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR);
  assert.equal(reopened.claims.filter(c => c.invalidatedAt).length, 1);
  assert.equal(reopened.claims.filter(c => c.staleAt).length, 2);
  assert.deepEqual(reopened.invalidate(base.id, 'again').invalidated, []);
  assert.deepEqual(reopened.invalidate(base.id, 'again').stale, []);
  assert.equal([...reopened.hmem.ledger.all()].length, ledgerBefore.length + 3, 'repeating adds nothing');
  assert.throws(() => reopened.invalidate('nope', 'x'), /CLAIM_NOT_FOUND/);
  // as-of reads: neither invalidated nor STALE claims are believed
  assert.deepEqual(reopened.believedAt(new Date().toISOString()).claims.map(c => c.id), [other.id]);
});

test('R6-M5: an invalidated SOSTENIDA claim is never REUSED; the warm start says INVALIDATED and re-probes', async () => {
  const dir = scratch(), cfg = universeConfig('AGENTFX');
  const fixture = structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!);
  const one: any = await runAgent('AGENTFX', 'agent-inv-1', { client: fixtureClient(cfg, fixture.tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false });
  recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-inv-1', discovery: one.artifacts.discovery, probes: one.artifacts.probes, dir });
  const relations = cfg.relations.filter((r: any) => one.artifacts.discovery.tables[r.from.table] && one.artifacts.discovery.tables[r.to.table]);
  const plan = () => planWarmStart({ universeId: 'AGENTFX', discovery: one.artifacts.discovery, relations, dir });
  assert.ok(plan().reused.some(item => item.relationId === 'orders_customer'));
  const r = new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR), target = r.claims.find(c => c.entity === 'relation:orders_customer' && c.value === 'SOSTENIDA')!;
  r.invalidate(target.id, 'upstream correction');
  const after = plan();
  assert.ok(!after.reused.some(item => item.relationId === 'orders_customer'));
  assert.equal(after.reprobe.find(item => item.relationId === 'orders_customer')?.reason, 'INVALIDATED');
  assert.ok(after.reused.some(item => item.relationId === 'orders_region'), 'other relations keep their memory');
  const view = memoryReport(new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR), 'agent-inv-1', 'x');
  const shown = view.claims.find(c => c.id === target.id);
  assert.ok(shown ? shown.invalidated && shown.invalidatedBy === target.id : true, 'the memory view exposes the invalidation');
});
