import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import { planWarmStart, relationVersion } from '../src/agent/memory.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { Reconciler } from '../src/reconcile/index.ts';
import { SOURCE_VERSION_UNSPECIFIED, SOURCE_VERSION_UNVERSIONED, isPlaceholderSourceVersion, isTrustedSustained, type SustainedProvenance } from '../src/reconcile/trusted-sustained.ts';
import { ROOT } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** RC-9: one definition of a trustworthy SOSTENIDA, used by the write gate, the persisted-state validation and the warm start. Behaviour is unchanged; this pins the equality. */
const runs = [{ label: 'no run', claim: {} as Partial<SustainedProvenance>, direct: undefined as string | undefined }, { label: 'claim run', claim: { runId: 'r1' }, direct: 'r1' }, { label: 'observation run only', claim: { observations: [{ runId: 'r2' }] }, direct: undefined }];
const receipts = [[], ['q1']], reviews = [undefined, 'PENDING', 'UNKNOWN', 'REVIEWED'] as const;
const matrix = runs.flatMap(run => receipts.flatMap(requestIds => reviews.map(reviewState => ({ run, requestIds, reviewState, label: `${run.label} / ${requestIds.length} receipts / ${reviewState}`, claim: { ...run.claim, requestIds, ...(reviewState ? { reviewState } : {}) } as SustainedProvenance }))));
// The three rules as they were written inline before the shared predicate.
const oldWriteGate = (c: SustainedProvenance) => !(!c.runId || !c.requestIds?.length || c.reviewState !== 'REVIEWED');
const oldPersisted = (c: SustainedProvenance) => c.reviewState === undefined || !(c.reviewState !== 'REVIEWED' || !(c.runId || (c.observations ?? []).some(item => item.runId)) || !c.requestIds?.length);
const oldWarmStart = (c: SustainedProvenance) => !(!(Boolean(c.runId) || (c.observations ?? []).some(item => Boolean(item.runId))) || !c.requestIds?.length || c.reviewState !== 'REVIEWED');

test('the shared predicate equals each of the three former inline rules over the whole provenance matrix', () => {
  assert.equal(matrix.length, 24);
  for (const item of matrix) {
    assert.equal(isTrustedSustained(item.claim), oldWarmStart(item.claim), `warm start: ${item.label}`);
    assert.equal(oldPersisted(item.claim), item.claim.reviewState === undefined || isTrustedSustained(item.claim), `persisted validation: ${item.label}`);
    if (item.run.label !== 'observation run only') assert.equal(isTrustedSustained(item.claim), oldWriteGate(item.claim), `write gate: ${item.label}`);
  }
  assert.equal(matrix.filter(item => isTrustedSustained(item.claim)).length, 2, 'only a run id (claim or observation) with a receipt and a REVIEWED contract is trusted');
});

test('the placeholder source versions are one set of constants', () => {
  assert.deepEqual([SOURCE_VERSION_UNSPECIFIED, SOURCE_VERSION_UNVERSIONED], ['unspecified', 'unversioned']);
  for (const placeholder of [undefined, null, '', 'unspecified', 'unversioned']) assert.equal(isPlaceholderSourceVersion(placeholder), true, String(placeholder));
  for (const real of ['rv1:abc', 'v2', 'UNSPECIFIED']) assert.equal(isPlaceholderSourceVersion(real), false, real);
  const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'trusted-'));
  try { assert.equal(new Reconciler('AGENTFX', path.join(dir, 'LOCAL-SYNTHETIC')).addClaim({ entity: 'relation:x', attribute: 'status', value: 'INDETERMINADA', source: 's', confidence: 0, requestIds: [] }).sourceVersion, SOURCE_VERSION_UNSPECIFIED); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the three sites behave as the predicate says: the write gate refuses, the strict load refuses, the warm start does not reuse', async () => {
  const cfg = universeConfig('AGENTFX'), relation = cfg.relations.find((item: any) => item.id === 'orders_customer');
  const fixture = structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!);
  const base: any = await runAgent('AGENTFX', 'agent-trusted-base', { client: fixtureClient(cfg, fixture.tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false });
  const V = relationVersion(base.artifacts.discovery, relation), NOW = Date.now(), made: string[] = [];
  try {
    for (const item of matrix.filter(entry => entry.run.label !== 'observation run only')) {
      const claim = { entity: 'relation:orders_customer', attribute: 'status', value: 'SOSTENIDA', source: 'rc9.src', confidence: 0.9, sourceVersion: V, observedAt: new Date(NOW - 60_000).toISOString(), rule: 'bounded_key_overlap', runId: item.run.direct, requestIds: [...item.requestIds], reviewState: item.reviewState };
      const trusted = isTrustedSustained(item.claim);
      const scratch = () => { const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'trusted-site-')); made.push(dir); return path.join(dir, 'LOCAL-SYNTHETIC'); };
      const gate = new Reconciler('AGENTFX', scratch(), 'concordia-agent', { strictSustained: true, origin: { executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' } });
      if (trusted) assert.doesNotThrow(() => gate.addClaim(claim as any), item.label); else assert.throws(() => gate.addClaim(claim as any), /SOSTENIDA_WITHOUT_RECEIPT_OR_REVIEW/, item.label);
      const dir = scratch(); new Reconciler('AGENTFX', dir, 'concordia-agent').addClaim(claim as any);
      const load = () => new Reconciler('AGENTFX', dir, 'concordia-agent', { strictSustained: true, origin: { executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' } });
      if (item.reviewState === undefined || trusted) assert.doesNotThrow(load, item.label); else assert.throws(load, /SOSTENIDA_WITHOUT_RECEIPT_OR_REVIEW/, item.label);
      if (item.reviewState === undefined || trusted) {
        const plan = planWarmStart({ universeId: 'AGENTFX', discovery: base.artifacts.discovery, relations: [relation], dir, now: () => NOW });
        assert.equal(plan.reused.length === 1, trusted, item.label);
      }
    }
  } finally { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); }
});
