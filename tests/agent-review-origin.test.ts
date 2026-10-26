import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import { AGENT_MEMORY_ACTOR, memoryReport, planWarmStart, relationVersion } from '../src/agent/memory.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { Reconciler } from '../src/reconcile/index.ts';
import { claimReviewOrigin } from '../src/reconcile/trusted-sustained.ts';
import { reviewModeSatisfied } from '../src/registry/review-mode.ts';
import { ROOT } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** R-seal: the review origin (HUMAN_REVIEWED / MODEL_REVIEWED) is sealed in claim, verdict and ledger; they are never confused; a model review never fills a slot that requires a human. */
const made: string[] = [];
const scratch = () => { const dir = fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')); made.push(dir); return path.join(dir, 'LOCAL-SYNTHETIC'); };
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const cfg = universeConfig('AGENTFX'), relation: any = cfg.relations.find((item: any) => item.id === 'orders_customer');
const origin = { executionMode: 'LOCAL' as const, dataOrigin: 'SYNTHETIC' as const };
let discovery: any, V = '';
test.before(async () => {
  const fixture = structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!);
  const report: any = await runAgent('AGENTFX', 'agent-seal-base', { client: fixtureClient(cfg, fixture.tables) as any, ...origin, persist: false, critic: false });
  discovery = report.artifacts.discovery; V = relationVersion(discovery, relation);
});
const claim = (over: Record<string, unknown> = {}) => ({ entity: 'relation:orders_customer', attribute: 'status', value: 'SOSTENIDA', source: 'seal.src', confidence: 0.9, requestIds: ['req-1'], reviewState: 'REVIEWED', sourceVersion: V,
  observedAt: '2026-10-25T00:00:00Z', rule: 'bounded_key_overlap', runId: 'run-seal', ...over });
const strict = (dir: string) => new Reconciler('AGENTFX', dir, AGENT_MEMORY_ACTOR, { strictSustained: true, origin });
const plan = (dir: string, reviewMode?: any) => planWarmStart({ universeId: 'AGENTFX', discovery, relations: [{ ...relation, ...(reviewMode ? { reviewMode } : {}) }], dir, origin, now: () => Date.parse('2026-10-26T00:00:00Z') });
const reasonOf = (result: ReturnType<typeof plan>) => result.reprobe[0]?.reason ?? 'REUSED';

test('R-seal: the origin is sealed in the claim and in the ledger; an invalid origin is refused; no review state means no origin', () => {
  const r = strict(scratch());
  const human = r.addClaim(claim()), model = r.addClaim(claim({ source: 'seal.model', reviewOrigin: 'MODEL_REVIEWED' }));
  assert.equal(claimReviewOrigin(human), 'HUMAN_REVIEWED', 'a REVIEWED contract with no declared origin reads as human');
  assert.equal(model.reviewOrigin, 'MODEL_REVIEWED');
  const sealed = [...r.hmem.ledger.all()].filter((entry: any) => entry.details?.event === 'review_origin_sealed');
  assert.deepEqual(sealed.map((entry: any) => entry.details.reviewOrigin), ['MODEL_REVIEWED'], 'the ledger records the declared seal');
  assert.throws(() => r.addClaim(claim({ source: 'x', reviewOrigin: 'ROBOT_REVIEWED' })), /REVIEW_ORIGIN_INVALID/);
  assert.equal(claimReviewOrigin({ reviewState: 'PENDING' }), undefined);
  assert.equal(r.claims.find(c => c.id === model.id)!.observations?.[0]?.reviewOrigin, 'MODEL_REVIEWED', 'the observation carries it too');
});

test('R-seal: a human-reviewed and a model-reviewed claim for the same value and source are different nodes, never merged', () => {
  const r = strict(scratch());
  const a = r.addClaim(claim({ reviewOrigin: 'HUMAN_REVIEWED' })), b = r.addClaim(claim({ reviewOrigin: 'MODEL_REVIEWED', requestIds: ['req-2'], runId: 'run-model' }));
  assert.notEqual(a.id, b.id);
  assert.deepEqual([a.reviewOrigin, b.reviewOrigin], ['HUMAN_REVIEWED', 'MODEL_REVIEWED']);
  assert.equal(r.addClaim(claim({ reviewOrigin: 'HUMAN_REVIEWED', requestIds: ['req-3'], runId: 'run-3' })).id, a.id, 'a same-origin observation still merges');
});

test('R-seal warm start: a MODEL_REVIEWED claim never fills a slot that requires a human, and a human claim never fills a model slot', () => {
  const dir = scratch(); strict(dir).addClaim(claim({ reviewOrigin: 'MODEL_REVIEWED' }));
  assert.equal(reasonOf(plan(dir, 'HUMAN')), 'REVIEW_ORIGIN_MISMATCH');
  assert.equal(reasonOf(plan(dir, 'BOTH')), 'REVIEW_ORIGIN_MISMATCH', 'BOTH needs a human claim as well');
  assert.equal(reasonOf(plan(dir, 'MODEL_ADVERSARIAL')), 'REUSED');
  assert.equal(reasonOf(plan(dir, 'HUMAN_OR_MODEL')), 'REUSED');
  assert.equal(reasonOf(plan(dir)), 'REUSED', 'a caller that declares no mode asks for nothing: legacy behaviour');
  assert.equal(plan(dir, 'MODEL_ADVERSARIAL').reused[0]?.reviewOrigin, 'MODEL_REVIEWED');
  const human = scratch(); strict(human).addClaim(claim({ reviewOrigin: 'HUMAN_REVIEWED' }));
  assert.equal(reasonOf(plan(human, 'MODEL_ADVERSARIAL')), 'REVIEW_ORIGIN_MISMATCH');
  assert.equal(reasonOf(plan(human, 'HUMAN')), 'REUSED');
});

test('R-seal warm start: with both claims present every mode is filled, each by the claim of the origin it asks for', () => {
  const dir = scratch(), r = strict(dir);
  const model = r.addClaim(claim({ source: 'seal.model', reviewOrigin: 'MODEL_REVIEWED' }));
  assert.equal(reasonOf(plan(dir, 'HUMAN')), 'REVIEW_ORIGIN_MISMATCH');
  const human = r.addClaim(claim({ reviewOrigin: 'HUMAN_REVIEWED' }));
  for (const mode of ['HUMAN', 'MODEL_ADVERSARIAL', 'HUMAN_OR_MODEL', 'BOTH'] as const) assert.equal(reasonOf(plan(dir, mode)), 'REUSED', mode);
  assert.equal(plan(dir, 'HUMAN').reused[0]?.claimId, human.id);
  assert.equal(plan(dir, 'MODEL_ADVERSARIAL').reused[0]?.claimId, model.id);
  const legacy = scratch(); strict(legacy).addClaim(claim());
  assert.equal(reasonOf(plan(legacy, 'HUMAN')), 'REUSED', 'a REVIEWED claim written before the seal reads as human');
});

test('R-seal: the pure origin rule (registry review-mode) and the memory view', () => {
  assert.equal(reviewModeSatisfied('HUMAN', ['MODEL_REVIEWED']), false);
  assert.equal(reviewModeSatisfied('MODEL_ADVERSARIAL', ['HUMAN_REVIEWED']), false);
  assert.equal(reviewModeSatisfied('BOTH', ['HUMAN_REVIEWED', 'MODEL_REVIEWED']), true);
  assert.equal(reviewModeSatisfied('HUMAN', []), false);
  const r = strict(scratch()); r.addClaim(claim({ reviewOrigin: 'MODEL_REVIEWED' }));
  assert.equal(memoryReport(r, 'run-seal', 'x').claims[0]!.reviewOrigin, 'MODEL_REVIEWED');
});

test('R-seal engine: each verdict carries its review origin, probed and REUSED_FROM_MEMORY', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')), 'LOCAL-SYNTHETIC'); made.push(path.dirname(dir));
  const run = (id: string) => runAgent('AGENTFX', id, { client: fixtureClient(cfg, structuredClone(agentFixtures().find(i => i.alias === 'AGENTFX')!).tables) as any, ...origin, persist: false, critic: false, memory: { dir } }) as Promise<any>;
  const first = await run('agent-seal-1'), second = await run('agent-seal-2');
  const reviewed = (report: any) => report.decisions.filter((d: any) => d.verdict === 'SOSTENIDA' || d.reasonCodes.includes('REUSED_FROM_MEMORY'));
  assert.ok(reviewed(first).length > 0 && reviewed(first).every((d: any) => d.reviewOrigin === 'HUMAN_REVIEWED'), JSON.stringify(first.decisions));
  assert.ok(second.decisions.some((d: any) => d.reasonCodes.includes('REUSED_FROM_MEMORY')));
  assert.ok(second.decisions.filter((d: any) => d.reasonCodes.includes('REUSED_FROM_MEMORY')).every((d: any) => d.reviewOrigin === 'HUMAN_REVIEWED'));
});
