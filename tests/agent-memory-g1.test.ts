import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import { planWarmStart, relationVersion } from '../src/agent/memory.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { Reconciler } from '../src/reconcile/index.ts';
import { DEFAULT_CONSUMER_FRESHNESS_TTL_MS } from '../src/reconcile/consumer-freshness.ts';
import { ROOT } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** G1: re-sustained claims never recycle closed ones, the warm start always has a TTL, and a claim without a real source version is never reused. */
const made: string[] = [];
const scratch = () => { const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-g1-')); made.push(dir); return path.join(dir, 'LOCAL-SYNTHETIC'); };
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const cfg = universeConfig('AGENTFX'), relation = cfg.relations.find((item: any) => item.id === 'orders_customer');
const NOW = Date.now(); // the real clock: a seeded observation must not lie in the future of the moment it is recorded (CLOCK_SKEW)
let discovery: any, V = '';
test.before(async () => {
  const fixture = structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!);
  const report: any = await runAgent('AGENTFX', 'agent-g1-base', { client: fixtureClient(cfg, fixture.tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false });
  discovery = report.artifacts.discovery; V = relationVersion(discovery, relation);
});
const claim = (over: Record<string, unknown> = {}) => ({ entity: 'relation:orders_customer', attribute: 'status', value: 'SOSTENIDA', source: 'g1.src', confidence: 0.9, requestIds: ['req-1'], reviewState: 'REVIEWED', sourceVersion: V,
  observedAt: new Date(NOW - 3600_000).toISOString(), rule: 'bounded_key_overlap', runId: 'run-g1', ...over });
const plan = (dir: string, extra: object = {}) => planWarmStart({ universeId: 'AGENTFX', discovery, relations: [relation], dir, now: () => NOW, ...extra });
const seed = (write: (r: Reconciler) => void) => { const dir = scratch(); write(new Reconciler('AGENTFX', dir, 'concordia-agent')); return dir; };

const relationEntry = (extra: Record<string, unknown> = {}) => ({ relationId: 'orders_customer', verdict: 'SOSTENIDA', rule: 'bounded_sample_key_membership', from: { db: 'D', table: 'orders', column: 'customer_id' }, to: { db: 'D', table: 'customers', column: 'customer_id' },
  relationContract: { reviewState: 'REVIEWED' }, evidence: { overlap: { ratio: 1 }, typeCompat: { castable: true }, queries: [{ requestId: 'req-1' }], utc: '2026-10-25T00:00:00Z', sourceVersion: V }, ...extra });
const inventory = { tables: { orders: { sourceVersion: 'v' } } };

test('a SOSTENIDA that is re-sustained after drift or invalidation opens a NEW claim; the closed one stays closed and untouched', () => {
  const r = new Reconciler('AGENTFX', scratch(), 'concordia-agent');
  r.ingest(inventory, { relations: [relationEntry()] }, { runId: 'agent-g1-a' });
  const first = r.claims.find(item => item.value === 'SOSTENIDA')!;
  r.ingest(inventory, { relations: [relationEntry({ verdict: 'INDETERMINADA', critic: { status: 'DEGRADED', reason: 'counterprobe broke it', counterprobes: [{ requestId: 'req-c', utc: '2026-10-25T01:00:00Z' }] } })] }, { runId: 'agent-g1-b' });
  const closed = r.claims.find(item => item.id === first.id)!, closedObservations = structuredClone(closed.observations);
  assert.notEqual(r.hmem.store.get(first.id)?.supersededBy, undefined, 'drift closed the first claim');
  r.ingest(inventory, { relations: [relationEntry({ evidence: { overlap: { ratio: 1 }, typeCompat: { castable: true }, queries: [{ requestId: 'req-2' }], utc: '2026-10-26T00:00:00Z', sourceVersion: V } })] }, { runId: 'agent-g1-c' });
  const sustained = r.claims.filter(item => item.entity === 'relation:orders_customer' && item.value === 'SOSTENIDA');
  assert.equal(sustained.length, 2, 'the re-sustained value opened a new claim');
  assert.deepEqual(r.claims.find(item => item.id === first.id)!.observations, closedObservations, 'the closed claim gained no observation');
  const reopened = sustained.find(item => item.id !== first.id)!;
  r.invalidate(reopened.id, 'source retracted');
  r.ingest(inventory, { relations: [relationEntry({ evidence: { overlap: { ratio: 1 }, typeCompat: { castable: true }, queries: [{ requestId: 'req-3' }], utc: '2026-10-27T00:00:00Z', sourceVersion: V } })] }, { runId: 'agent-g1-d' });
  const afterInvalidation = r.claims.filter(item => item.entity === 'relation:orders_customer' && item.value === 'SOSTENIDA');
  assert.equal(afterInvalidation.length, 3, 'an invalidated claim is not recycled either');
  const open = afterInvalidation.find(item => item.invalidatedAt === undefined && !r.hmem.store.get(item.id)?.supersededBy)!;
  r.ingest(inventory, { relations: [relationEntry({ evidence: { overlap: { ratio: 1 }, typeCompat: { castable: true }, queries: [{ requestId: 'req-4' }], utc: '2026-10-28T00:00:00Z', sourceVersion: V } })] }, { runId: 'agent-g1-e' });
  assert.equal(r.claims.filter(item => item.value === 'SOSTENIDA').length, 3, 'an open claim still absorbs a re-observation without a second vote');
  assert.ok(r.claims.find(item => item.id === open.id)!.observations!.length >= 2);
});

test('the warm start always has a TTL: none given means the consumer-freshness default, an explicit one overrides it', () => {
  assert.equal(DEFAULT_CONSUMER_FRESHNESS_TTL_MS, 24 * 3600 * 1000);
  const recent = seed(r => r.addClaim(claim() as any)), old = seed(r => r.addClaim(claim({ observedAt: new Date(NOW - 2 * 24 * 3600 * 1000).toISOString() }) as any));
  assert.deepEqual(plan(recent).reused.map(item => item.relationId), ['orders_customer'], 'inside the default window it is reused');
  assert.equal(plan(old).reprobe[0]?.reason, 'EXPIRED', 'two days old with no TTL given is expired, not eternal');
  assert.deepEqual(plan(old, { ttlMs: 3 * 24 * 3600 * 1000 }).reused.map(item => item.relationId), ['orders_customer'], 'an explicit TTL wins');
});

test('RC-4 freshness is measured from the most recent PROBED observation: a stable relation that keeps being re-observed stays reusable, a reuse does not refresh it', () => {
  const day = 24 * 3600 * 1000, iso = (ms: number) => new Date(ms).toISOString();
  const stable = seed(r => { r.addClaim(claim({ observedAt: iso(NOW - 3 * day) }) as any); r.addClaim(claim({ observedAt: iso(NOW - 3600_000), requestIds: ['req-2'], runId: 'run-g1-later' }) as any); });
  const [kept] = new Reconciler('AGENTFX', stable).claims;
  assert.equal(kept.observedAt, iso(NOW - 3 * day), 'the original observedAt is not rewritten (bi-temporal history)');
  assert.equal(kept.lastObservedAt, iso(NOW - 3600_000));
  assert.deepEqual(plan(stable).reused.map(item => item.relationId), ['orders_customer'], 'three days after the first observation but one hour after the last: reused');
  const merelyReused = seed(r => { r.addClaim(claim({ observedAt: iso(NOW - 3 * day) }) as any); r.addClaim(claim({ observedAt: iso(NOW - 3600_000), rule: 'reused_from_memory', requestIds: ['req-2'], runId: 'run-g1-reuse' }) as any); });
  assert.equal(plan(merelyReused).reprobe[0]?.reason, 'EXPIRED', 'a reuse is not a re-observation and never refreshes freshness');
});

test('RC-4 migration of a legacy claim without a review stamp: it is not reused as it is; one strict re-observation stamps it in place and keeps its id and history', () => {
  const dir = seed(r => r.addClaim(claim({ reviewState: undefined }) as any));
  assert.equal(plan(dir).reprobe[0]?.reason, 'UNTRUSTED_PROVENANCE');
  const [legacy] = new Reconciler('AGENTFX', dir).claims, before = new Reconciler('AGENTFX', dir).claims.length;
  assert.equal(legacy.reviewState, undefined);
  const strict = new Reconciler('AGENTFX', dir, 'concordia-agent', { strictSustained: true, origin: { executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' } });
  strict.addClaim(claim({ requestIds: ['req-fresh'], runId: 'run-g1-migrate', observedAt: new Date(NOW - 60_000).toISOString() }) as any);
  const [migrated] = new Reconciler('AGENTFX', dir).claims;
  assert.equal(migrated.id, legacy.id, 'the claim is stamped in place, not replaced'); assert.equal(new Reconciler('AGENTFX', dir).claims.length, before, 'no claim is added or dropped');
  assert.deepEqual([migrated.reviewState, migrated.executionMode, migrated.dataOrigin], ['REVIEWED', 'LOCAL', 'SYNTHETIC']);
  assert.equal((migrated.observations ?? []).length, 2, 'the legacy observation stays');
  assert.deepEqual(plan(dir).reused.map(item => item.relationId), ['orders_customer']);
});

test('a claim with no real source version is never reused', () => {
  for (const sourceVersion of [undefined, 'unspecified', 'unversioned', '']) {
    const dir = seed(r => r.addClaim(claim({ sourceVersion }) as any));
    assert.equal(plan(dir).reprobe[0]?.reason, 'UNTRUSTED_PROVENANCE', String(sourceVersion));
  }
});
