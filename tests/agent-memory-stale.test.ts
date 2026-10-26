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

/** M8-2: STALE dependents and the human review queue. */
const made: string[] = [];
const scratch = () => { const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')); made.push(dir); return path.join(dir, 'LOCAL-SYNTHETIC'); };
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const cfg = universeConfig('AGENTFX');
const origin = { executionMode: 'LOCAL' as const, dataOrigin: 'SYNTHETIC' as const };

async function twoRuns(dir: string) {
  const fixture = structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!);
  const one: any = await runAgent('AGENTFX', 'agent-stale-1', { client: fixtureClient(cfg, fixture.tables) as any, ...origin, persist: false, critic: false });
  recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-stale-1', discovery: one.artifacts.discovery, probes: one.artifacts.probes, dir, origin });
  const relations = cfg.relations.filter((r: any) => one.artifacts.discovery.tables[r.from.table] && one.artifacts.discovery.tables[r.to.table]);
  const plan = () => planWarmStart({ universeId: 'AGENTFX', discovery: one.artifacts.discovery, relations, dir, origin });
  const warm = plan();
  const second = recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-stale-2', discovery: one.artifacts.discovery, probes: [], warmStart: warm, dir, origin });
  return { plan, warm, second, one };
}

test('M8-2: a reuse is an observation of the original, not a node: invalidating the original excludes the reuse and the memory gains no claim per reuse', async () => {
  const dir = scratch(), { plan, warm } = await twoRuns(dir);
  assert.ok(warm.reused.some(item => item.relationId === 'orders_customer'));
  const r = new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR);
  assert.ok(r.claims.every(c => !c.source.startsWith('reuse:')), 'no claim per reuse');
  const original = r.claims.find(c => c.entity === 'relation:orders_customer' && c.value === 'SOSTENIDA')!;
  assert.ok((original.observations ?? []).some(item => item.runId === 'agent-stale-2' && item.tier === 'reused'), 'the reuse is recorded on the original');
  assert.deepEqual(r.invalidate(original.id, 'upstream correction').stale, [], 'nothing depends on it');
  assert.equal(plan().reprobe.find(item => item.relationId === 'orders_customer')?.reason, 'INVALIDATED');
});

test('M8-2: a STALE claim is never reused on its own: with the original gone from the picture the relation reports STALE_DEPENDENCY', () => {
  const dir = scratch(), r = new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR);
  const base = r.addClaim({ entity: 'relation:x', attribute: 'status', value: 'SOSTENIDA', source: 's', confidence: 0.9, requestIds: ['q'], sourceVersion: 'v', observedAt: '2026-10-25T00:00:00Z', rule: 'x', runId: 'r1' });
  const dep = r.addClaim({ entity: 'relation:y', attribute: 'status', value: 'SOSTENIDA', source: 'd', confidence: 0.9, requestIds: ['q'], sourceVersion: 'v', observedAt: '2026-10-25T00:00:00Z', rule: 'x', runId: 'r1' }, false, [base.id]);
  r.invalidate(base.id, 'gone');
  const discovery = { tables: {} } as any;
  const reasons = planWarmStart({ universeId: 'AGENTFX', discovery, relations: [{ id: 'y', from: { table: 'a', column: 'c' }, to: { table: 'b', column: 'c' } } as any], dir, origin }).reprobe.map(item => item.reason);
  assert.deepEqual(reasons, ['STALE_DEPENDENCY']);
  assert.ok(r.claims.find(c => c.id === dep.id)!.staleAt);
});

test('M8-2: STALE propagates transitively (alternative → human correction → claim derived from the correction); each enters the queue with the ROOT cause; idempotent', () => {
  const dir = scratch(), r = new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR);
  const mk = (entity: string, value: string, source: string) => ({ entity, attribute: 'attr', value, source, confidence: 0.8, requestIds: [source], sourceVersion: 'v', observedAt: '2026-10-25T00:00:00Z', rule: 'x', runId: 'r1' });
  const a = r.addClaim(mk('U:e', 'A', 's1')), b = r.addClaim(mk('U:e', 'B', 's2'));
  r.detect();
  const conflict = r.conflicts.find(c => c.claimIds.includes(a.id) && c.claimIds.includes(b.id))!;
  r.resolve(conflict.id, a.id, true, 'choose A', conflict.version);
  const correction = r.claims.find(c => c.id === r.conflicts.find(x => x.id === conflict.id)!.correction)!;
  const level2 = r.addClaim(mk('U:other', 'C', 's3'), false, [correction.id]);
  const before = [...r.hmem.ledger.all()].length;
  const result = r.invalidate(a.id, 'root cause');
  assert.deepEqual(result.stale.sort(), [correction.id, level2.id].sort());
  assert.equal([...r.hmem.ledger.all()].length, before + 3, 'one ledger entry per state change');
  const queue = (memoryReport(r, 'r1', 'x').reviewQueue as any[]).filter(item => item.kind === 'STALE_DEPENDENCY');
  assert.deepEqual(queue.map(item => item.claimId).sort(), [correction.id, level2.id].sort());
  assert.ok(queue.every(item => item.causeClaimId === a.id && /root cause/.test(item.reason)), 'every item names the root cause');
  assert.deepEqual(r.invalidate(a.id, 'again'), { rootClaimId: a.id, invalidated: [], stale: [] });
  assert.equal([...r.hmem.ledger.all()].length, before + 3, 'idempotent');
});

test('M8-2: with no dependents nothing changes but the root', () => {
  const dir = scratch(), r = new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR);
  const mk = (entity: string) => ({ entity, attribute: 'status', value: 'INDETERMINADA', source: 's', confidence: 0.5, requestIds: ['q'], sourceVersion: 'v', observedAt: '2026-10-25T00:00:00Z', rule: 'x', runId: 'r1' });
  const lone = r.addClaim(mk('relation:z')), other = r.addClaim(mk('relation:w'));
  const result = r.invalidate(lone.id, 'x');
  assert.deepEqual([result.invalidated, result.stale], [[lone.id], []]);
  assert.equal(r.claims.find(c => c.id === other.id)!.staleAt, undefined);
});

test('M8-2: a human correction derives from both alternatives; invalidating one makes the correction STALE and queued', () => {
  const dir = scratch(), r = new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR);
  const mk = (value: string, source: string, confidence: number) => ({ entity: 'U:e', attribute: 'attr', value, source, confidence, requestIds: [source], sourceVersion: 'v', observedAt: '2026-10-25T00:00:00Z', rule: 'x', runId: 'r1' });
  const a = r.addClaim(mk('A', 's1', 0.8)), b = r.addClaim(mk('B', 's2', 0.8));
  r.detect();
  const conflict = r.conflicts.find(c => c.claimIds.includes(a.id) && c.claimIds.includes(b.id))!;
  assert.ok(conflict, 'a conflict was detected');
  r.resolve(conflict.id, a.id, true, 'choose A', conflict.version);
  const correction = r.claims.find(c => c.id === r.conflicts.find(x => x.id === conflict.id)!.correction)!;
  assert.deepEqual([...(r.hmem.store.get(correction.id)?.derivedFrom ?? [])].sort(), [a.id, b.id].sort());
  const result = r.invalidate(b.id, 'source b retracted');
  assert.ok(result.stale.includes(correction.id));
  const view = memoryReport(r, 'r1', 'x');
  assert.ok((view.reviewQueue as any[]).some(item => item.kind === 'STALE_DEPENDENCY' && item.claimId === correction.id && item.causeClaimId === b.id));
});
