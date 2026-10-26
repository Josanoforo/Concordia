import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCandidateReview } from '../src/agent/model-review/candidate-review.ts';
import { attackAnswer, judgeAnswer } from '../src/agent/model-review/standin.ts';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import type { CandidateReviewRequest } from '../src/agent/model-review-contract.ts';
import { offlineAgentDeps } from '../src/agent/offline-deps.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { RunBudget } from '../src/agent/run-budget.ts';
import { ROOT } from '../src/runtime.ts';
import { loadF04Set, MIN_DISTINCT_KEYS } from './helpers/model-review-f04.ts';

const thresholds = { minDistinctKeys: MIN_DISTINCT_KEYS };
const request = (over: Partial<CandidateReviewRequest> = {}): CandidateReviewRequest => ({ universeId: 'TPCDS', runId: 'agent-r', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', proposals: loadF04Set().proposals as unknown[], tableColumns: {},
  budget: new RunBudget({ maxQueriesPerRun: 5, readLimit: 50, maxTokensPerRun: 1_000_000, maxSteps: 3 }), now: () => '2026-10-26T00:00:00.000Z', ...over });
/** A Nightshift lookalike that answers like the stand-ins but through the real client surface (route, chat, receipt). */
const fakeNightshift = (route = 'meterless/judge-route') => {
  const calls: { route?: string; system: string }[] = [];
  const client = { route, calls, async chat(messages: { role: string; content: string }[], options: { maxTokens: number; route?: string }) {
    calls.push({ route: options.route, system: messages[0]!.content });
    const packet = JSON.parse(messages[1]!.content).packet, isAttack = /adversarial reviewer/.test(messages[0]!.content);
    const text = isAttack ? attackAnswer(packet) : judgeAnswer('SEMANTIC', packet);
    return { text, receipt: { receiptId: `r-${calls.length}`, provider: 'p', model: options.route ?? route, inputTokens: 900, outputTokens: 100, totalTokens: 1000, latencyMs: 1, fromCache: false }, policyAlerts: [], truncated: false };
  } };
  return client as any;
};

test('stand-in factory: the closure the engine takes returns a MODEL_REVIEW overlay and the 25 MODEL_REVIEWED contracts, charging the run budget', async () => {
  const req = request(), review = createCandidateReview({ standIn: true, thresholds });
  const out = await review(req);
  assert.equal(out.overlay.origin, 'MODEL_REVIEW'); assert.equal(out.contracts.length, 25);
  assert.ok(out.contracts.every(contract => contract.reviewOrigin === 'MODEL_REVIEWED' && contract.reviewState === 'REVIEWED' && contract.from.db === 'TPCDS_DB'));
  assert.ok(req.budget.tokens > 0); assert.equal((out.overlay as any).counts.tokens, req.budget.tokens);
  assert.equal((out.overlay as any).provenance, 'STAND_IN_OFFLINE');
});

test('a stand-in is refused in a LIVE run; bad options fail closed', async () => {
  await assert.rejects(() => createCandidateReview({ standIn: true, thresholds })(request({ executionMode: 'LIVE' })), /STAND_IN_IN_LIVE_RUN/);
  assert.throws(() => createCandidateReview({ thresholds }), /NO_MODEL/);
  assert.throws(() => createCandidateReview({ standIn: true, thresholds, judgeCount: 4 }), /JUDGES_OUT_OF_RANGE/);
  assert.throws(() => createCandidateReview({ standIn: true, thresholds: { minDistinctKeys: 0 } }), /MIN_DISTINCT_KEYS/);
  assert.throws(() => createCandidateReview({ standIn: true, thresholds, config: { attackScope: 'NONE' } }), /ADVERSARIAL_PASS_REQUIRED/);
  assert.throws(() => createCandidateReview({ judges: [], thresholds }), /MODELS_INCOMPLETE/);
});

test('live factory over the agent client: judges and adversary go through chat() with their routes, contracts are LIVE_MODEL and allowed in a LIVE run', async () => {
  const client = fakeNightshift();
  const req = request({ executionMode: 'LIVE' });
  const out = await createCandidateReview({ model: client, adversaryRoute: 'meterless/adversary-route', thresholds })(req);
  assert.equal((out.overlay as any).provenance, 'LIVE_MODEL'); assert.equal(out.contracts.length, 25);
  const judgeCalls = client.calls.filter((call: any) => !/adversarial reviewer/.test(call.system)), attackCalls = client.calls.filter((call: any) => /adversarial reviewer/.test(call.system));
  assert.ok(judgeCalls.length > 0 && judgeCalls.every((call: any) => call.route === undefined), 'judges use the client route');
  assert.equal(attackCalls.length, 25); assert.ok(attackCalls.every((call: any) => call.route === 'meterless/adversary-route'));
  assert.equal(req.budget.tokens, client.calls.length * 1000, 'every generation charged from its receipt');
});

test('tokens per evaluation and per attack are on the records and add up to the call and the review', async () => {
  const out = await createCandidateReview({ model: fakeNightshift(), thresholds })(request());
  const reviews = (out.overlay as any).reviews as any[];
  const approved = reviews.find(item => item.decision === 'accept');
  assert.equal(approved.evaluations.length, 2);
  for (const evaluation of approved.evaluations) { assert.equal(evaluation.tokens, 1000); assert.equal(evaluation.call.tokens, 1000); assert.equal(evaluation.call.requestedModel, 'meterless/judge-route'); assert.equal(evaluation.call.receipt.totalTokens, 1000); assert.ok(evaluation.call.responseText.length > 0); }
  assert.equal(approved.adversary.tokens, 1000);
  assert.equal(approved.adversary.attacks.length, 4);
  assert.equal(approved.adversary.attacks.reduce((sum: number, attack: any) => sum + attack.tokens, 0), 1000, 'the single adversary call is split over its four attack records');
  assert.equal(approved.tokens, approved.evaluations.reduce((s: number, e: any) => s + e.tokens, 0) + approved.adversary.tokens);
  assert.ok(reviews.every(item => item.evaluations.every((e: any) => typeof e.tokens === 'number' && e.tokens >= 0)));
  assert.equal(reviews.reduce((s, item) => s + item.tokens, 0), (out.overlay as any).counts.tokens);
});

class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
test('the factory plugs into the engine as AgentDeps.candidateReview (NWCH, offline): the section reports the review', async () => {
  const fixture = structuredClone(agentFixtures().find(item => item.alias === 'NWCH')!), runId = 'agent-x8-factory';
  const dir = path.join(ROOT, '.concordia', 'agent-runs', runId);
  try {
    const report: any = await runAgent('NWCH', runId, { ...offlineAgentDeps('NWCH', fixture, new Script([...fixture.chooserScript])), persist: false, critic: false, candidateReview: createCandidateReview({ standIn: true, thresholds }) });
    const section = report.phases.candidateReview;
    assert.ok(['APPLIED', 'NOTHING_APPROVED'].includes(section.status), JSON.stringify(section).slice(0, 400));
    assert.equal(section.provenance, 'STAND_IN_OFFLINE');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------- R-1 warm start: the engine passes request.reusable
const REUSABLE_YES = ['catalog_returns.cr_reason_sk__reason.r_reason_sk', 'store_returns.sr_reason_sk__reason.r_reason_sk', 'web_returns.wr_reason_sk__reason.r_reason_sk', 'catalog_returns.cr_warehouse_sk__warehouse.w_warehouse_sk', 'catalog_sales.cs_warehouse_sk__warehouse.w_warehouse_sk'];
const DEFERRED_ID = 'inventory.inv_warehouse_sk__warehouse.w_warehouse_sk';

test('warm start: reusable candidates are not reviewed again, are listed as reused (not as reviewed or rejected), and cost no tokens', async () => {
  const full = request(), reuse = request();
  const baseline = await createCandidateReview({ standIn: true, thresholds })(full);
  const out = await createCandidateReview({ standIn: true, thresholds })({ ...reuse, reusable: REUSABLE_YES });
  const overlay = out.overlay as any;
  assert.deepEqual(overlay.reused.map((item: any) => item.relationId), REUSABLE_YES);
  assert.ok(overlay.reused.every((item: any) => item.reason.startsWith('REUSED_FROM_MEMORY')));
  assert.equal(overlay.counts.reused, 5);
  assert.equal(out.contracts.length, 20, 'the engine keeps the 5 reuses; the reviewer does not re-approve them');
  assert.ok(!out.contracts.some(contract => REUSABLE_YES.includes(contract.id)));
  assert.ok(!overlay.notApproved.some((item: any) => REUSABLE_YES.includes(item.relationId)), 'a reused candidate is not a rejection');
  assert.ok(!overlay.reviews.some((item: any) => REUSABLE_YES.includes(item.relationId)), 'and was not reviewed');
  assert.ok(reuse.budget.tokens < full.budget.tokens, `${reuse.budget.tokens} < ${full.budget.tokens}`);
  assert.equal(baseline.contracts.length, 25);
});

test('warm start: with reviewReusable the reusable ones are reviewed again; one that is not approved comes back notApproved with reviewed:true', async () => {
  const out = await createCandidateReview({ standIn: true, thresholds, reviewReusable: true })({ ...request(), reusable: [REUSABLE_YES[0]!, DEFERRED_ID] });
  const overlay = out.overlay as any;
  assert.deepEqual(overlay.reused, []);
  assert.ok(out.contracts.some(contract => contract.id === REUSABLE_YES[0]), 'still approved: a contract');
  const notApproved = overlay.notApproved.find((item: any) => item.relationId === DEFERRED_ID);
  assert.deepEqual([notApproved.decision, notApproved.reviewed], ['defer', true]);
  assert.ok(overlay.reviews.some((item: any) => item.relationId === DEFERRED_ID));
});

test('warm start: a reusable candidate that this run evidence now excludes is notApproved and reviewed, with no tokens, even when reuse is the default', async () => {
  const proposals = structuredClone(loadF04Set().proposals) as any[];
  const target = proposals.find(item => item.proposalId === REUSABLE_YES[0])!;
  target.coverageProbe.diagnostic.suspect = { value: true, reasons: ['COMPETING_TARGET'], preferredTarget: 'x' };
  const req = request({ proposals, reusable: [REUSABLE_YES[0]!, REUSABLE_YES[1]!] });
  const out = await createCandidateReview({ standIn: true, thresholds })(req);
  const overlay = out.overlay as any;
  const dropped = overlay.notApproved.find((item: any) => item.relationId === REUSABLE_YES[0]);
  assert.deepEqual([dropped.decision, dropped.reviewed, dropped.reasons[0]], ['defer', true, 'REUSABLE_NOW_EXCLUDED:SUSPECT:COMPETING_TARGET']);
  assert.deepEqual(overlay.reused.map((item: any) => item.relationId), [REUSABLE_YES[1]]);
});
