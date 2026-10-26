import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { AGENT_MEMORY_ACTOR, planWarmStart, relationVersion } from '../src/agent/memory.ts';
import { Reconciler, claimTier } from '../src/reconcile/index.ts';
import { ROOT } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

const made: string[] = [];
const scratch = () => { const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')); made.push(dir); return path.join(dir, 'LOCAL-SYNTHETIC'); };
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const cfg = universeConfig('AGENTFX');
const run = (dir: string, runId: string) => runAgent('AGENTFX', runId, { client: fixtureClient(cfg, structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!).tables) as any, executionMode: 'LOCAL',
  dataOrigin: 'SYNTHETIC', persist: false, critic: false, memory: { dir } }) as Promise<any>;

test('R6-M3: a probed claim is observed, a run that reuses it is recorded as reused on the observation, and the claim keeps its tier', async () => {
  const dir = scratch();
  const first = await run(dir, 'agent-tier-1'), second = await run(dir, 'agent-tier-2');
  assert.ok(first.memory.claims.length > 0 && first.memory.claims.every((c: any) => c.tier === 'observed' && c.reusedBy.length === 0));
  const reusedClaims = second.memory.claims.filter((c: any) => c.reusedBy.length);
  assert.ok(reusedClaims.length >= 1, 'the second run reused something');
  assert.ok(reusedClaims.every((c: any) => c.tier === 'observed' && c.reusedBy.includes('agent-tier-2')), 'the claim stays observed; the reuse is a tier-reused observation');
});

test('R6-M3: a human correction is reviewed, and claims written before tiers existed read as observed or reviewed without being rewritten', () => {
  assert.equal(claimTier({ source: 'NY.t', rule: 'bounded_key_overlap' }), 'observed');
  assert.equal(claimTier({ source: 'review:ana' }), 'reviewed');
  assert.equal(claimTier({ source: 'x', rule: 'human-correction' }), 'reviewed');
  assert.equal(claimTier({ source: 'x', tier: 'reused' }), 'reused');
  const dir = scratch(), reconciler = new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR);
  const base = { entity: 'relation:r', attribute: 'status', value: 'SOSTENIDA', source: 's', confidence: 0.9, requestIds: ['q'], sourceVersion: 'v', observedAt: '2026-10-25T00:00:00Z', rule: 'x' };
  assert.equal(reconciler.addClaim({ ...base, runId: 'r1' }).tier, 'observed');
  assert.equal(reconciler.addClaim({ ...base, value: 'INDETERMINADA', source: 'review:ana' }, true).tier, 'reviewed');
  assert.equal(reconciler.addClaim({ ...base, value: 'X', source: 's2', rule: 'reused_from_memory', runId: 'r2' }).observations![0]!.tier, 'reused');
});

test('R6-M3: the tier is a label only: changing it on every claim leaves the warm start plan and the reuse unchanged', async () => {
  const dir = scratch();
  await run(dir, 'agent-tier-3');
  const fixture = structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!);
  const base: any = await run(scratch(), 'agent-tier-3b');
  const discovery = base.artifacts.discovery, relations = cfg.relations.filter((r: any) => discovery.tables[r.from.table] && discovery.tables[r.to.table]);
  const planOf = () => planWarmStart({ universeId: 'AGENTFX', discovery, relations, dir });
  const before = planOf();
  const reconciler = new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR);
  for (const claim of reconciler.claims) claim.tier = 'reviewed';
  reconciler.persist();
  assert.deepEqual(planOf(), before);
  assert.ok(before.reused.length >= 1 && relationVersion(discovery, relations[0]).startsWith('rv1:') && fixture);
});
