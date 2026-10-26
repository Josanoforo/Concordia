import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import { AGENT_MEMORY_ACTOR, planWarmStart, recordRunMemory, relationVersion } from '../src/agent/memory.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { Reconciler } from '../src/reconcile/index.ts';
import { ROOT } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** Clock hygiene of the memory: a future observedAt cannot stretch the TTL (CLOCK_SKEW), and transaction times come from an injected clock when given. */
const made: string[] = [];
const scratch = () => { const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')); made.push(dir); return path.join(dir, 'LOCAL-SYNTHETIC'); };
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const cfg = universeConfig('AGENTFX'), relation = cfg.relations.find((item: any) => item.id === 'orders_customer');
const origin = { executionMode: 'LOCAL' as const, dataOrigin: 'SYNTHETIC' as const };
let discovery: any, V = '', probes: any[] = [];
test.before(async () => {
  const fixture = structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!);
  const report: any = await runAgent('AGENTFX', 'agent-clock-base', { client: fixtureClient(cfg, fixture.tables) as any, ...origin, persist: false, critic: false });
  discovery = report.artifacts.discovery; probes = report.artifacts.probes; V = relationVersion(discovery, relation);
});
const claim = (over: Record<string, unknown> = {}) => ({ entity: 'relation:orders_customer', attribute: 'status', value: 'SOSTENIDA', source: 'clock.src', confidence: 0.9, requestIds: ['req-1'], reviewState: 'REVIEWED', sourceVersion: V,
  observedAt: '2026-10-19T00:00:00Z', rule: 'bounded_key_overlap', runId: 'run-clock', ...over });
const plan = (dir: string, nowIso: string) => planWarmStart({ universeId: 'AGENTFX', discovery, relations: [relation], dir, origin, ttlMs: 7 * 24 * 3600_000, now: () => Date.parse(nowIso) });

test('M8 clock: a future observedAt is clipped to now (not trusted as later than the clock) and the skew is reported', () => {
  const dir = scratch();
  new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR, { strictSustained: true, origin, now: () => '2026-10-20T00:00:00.000Z' }).addClaim(claim({ observedAt: '2027-12-31T00:00:00Z' }));
  const result = plan(dir, '2026-10-22T00:00:00.000Z');
  assert.deepEqual(result.clockSkew?.map(item => [item.relationId, item.observedAt, item.clippedTo]), [['orders_customer', '2027-12-31T00:00:00.000Z', '2026-10-22T00:00:00.000Z']]);
  assert.equal(result.reused.length, 1, 'clipped to now it is as fresh as now, no fresher');
});

test('M8 clock: an honest claim has no clockSkew', () => {
  const dir = scratch();
  new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR, { strictSustained: true, origin, now: () => '2026-10-20T00:00:00.000Z' }).addClaim(claim());
  const result = plan(dir, '2026-10-22T00:00:00.000Z');
  assert.equal(result.reused.length, 1); assert.equal(result.clockSkew, undefined);
});

test('M8 clock: recordRunMemory takes the injected clock for transaction times', () => {
  const dir = scratch();
  recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-clock-1', discovery, probes, dir, origin, now: () => '2026-10-21T08:00:00.000Z' });
  const claims = new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR).claims;
  assert.ok(claims.length > 0 && claims.every(c => c.recordedAt === '2026-10-21T08:00:00.000Z'));
});
