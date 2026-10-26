import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { AGENT_MEMORY_ACTOR, recordRunMemory } from '../src/agent/memory.ts';
import { Reconciler, claimTime, type Claim } from '../src/reconcile/index.ts';
import { ROOT } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

const made: string[] = [];
const scratch = () => { const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')); made.push(dir); return path.join(dir, 'LOCAL-SYNTHETIC'); };
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const offline = (runId: string, observedAt: string, mutate?: (tables: any) => void) => {
  const fixture = structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!); mutate?.(fixture.tables);
  return runAgent('AGENTFX', runId, { client: fixtureClient(universeConfig('AGENTFX'), fixture.tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false, now: () => observedAt }) as Promise<any>;
};

test('R6-M4: a new claim carries world time (validFrom) and transaction time (recordedAt), open ended', () => {
  const reconciler = new Reconciler('AGENTFX', scratch(), AGENT_MEMORY_ACTOR);
  const claim = reconciler.addClaim({ entity: 'relation:r', attribute: 'status', value: 'SOSTENIDA', source: 's', confidence: 0.9, requestIds: ['q'], sourceVersion: 'v', observedAt: '2026-10-20T00:00:00Z', rule: 'x', runId: 'r1' });
  assert.equal(claim.validFrom, '2026-10-20T00:00:00Z');
  assert.ok(claim.recordedAt && claim.recordedAt > claim.validFrom, 'we learned it after it was true');
  assert.equal(claim.validTo, undefined); assert.equal(claim.supersededAt, undefined);
});

test('R6-M4: when a later run contradicts, the old claim is closed (validTo, supersededAt), not rewritten, and as-of reads answer both times', async () => {
  const dir = scratch();
  const one = await offline('agent-bt-1', '2026-10-20T00:00:00Z');
  recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-bt-1', discovery: one.artifacts.discovery, probes: one.artifacts.probes, dir });
  const between = new Date().toISOString();
  await sleep(15);
  const two = await offline('agent-bt-2', '2026-10-25T00:00:00Z', tables => { tables.customers.rows = [['z1', 'Zed', 's1'], ['z2', 'Yan', 's2'], ['z3', 'Xia', 's3']]; });
  recordRunMemory({ universeId: 'AGENTFX', runId: 'agent-bt-2', discovery: two.artifacts.discovery, probes: two.artifacts.probes, dir });
  const reconciler = new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR);
  const history = reconciler.claims.filter(c => c.entity === 'relation:orders_customer');
  const old = history.find(c => c.value === 'SOSTENIDA')!, next = history.find(c => c.id !== old.id)!;
  assert.equal(old.value, 'SOSTENIDA', 'the value is never rewritten');
  assert.equal(old.validTo, next.validFrom, 'it stopped being valid when the successor starts');
  assert.ok(old.supersededAt && old.supersededAt > between, 'we stopped believing it at the time of the contradicting run');
  assert.equal(next.validTo, undefined);
  // what we believed before and after the second run, and what held in the source on each date
  const before = reconciler.believedAt(between).claims.filter(c => c.entity === 'relation:orders_customer');
  assert.deepEqual(before.map(c => c.id), [old.id]);
  const after = reconciler.believedAt(new Date().toISOString()).claims.filter(c => c.entity === 'relation:orders_customer');
  assert.deepEqual(after.map(c => c.id), [next.id]);
  const world = reconciler.believedAt(new Date(Date.now() - 3600_000).toISOString(), '2026-10-22T00:00:00Z');
  assert.equal(world.claims.length, 0, 'nothing was known an hour ago');
  assert.deepEqual(reconciler.believedAt(new Date().toISOString(), '2026-10-21T00:00:00Z').claims.filter(c => c.entity === 'relation:orders_customer').map(c => c.id), [], 'the old claim is no longer believed even for the dates it described');
});

test('R6-M4: claims written before bi-temporal fields still read; a superseded legacy claim reports an unknown end instead of guessing', () => {
  const legacy = { id: 'm1', entity: 'relation:r', attribute: 'status', value: 'SOSTENIDA', source: 's', confidence: 1, entities: [], domain: 'D', requestIds: [], observedAt: '2026-10-01T00:00:00Z' } as Claim;
  assert.deepEqual(claimTime(legacy, false), { validFrom: '2026-10-01T00:00:00Z', validTo: null, recordedAt: '2026-10-01T00:00:00Z', supersededAt: null, legacy: false });
  assert.equal(claimTime(legacy, true).legacy, true);
  const noObserved = { ...legacy, observedAt: undefined } as Claim;
  assert.equal(claimTime(noObserved, false).validFrom, new Date(0).toISOString());
});
