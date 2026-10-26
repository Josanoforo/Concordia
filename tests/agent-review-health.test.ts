import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, reviewHealthOf, REVIEW_HEALTH_CODES } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import type { CandidateReview, CandidateReviewRequest } from '../src/agent/model-review-contract.ts';
import { offlineAgentDeps } from '../src/agent/offline-deps.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';

/** E1-01: a model review that finished but is defective (budget cut, invalid/truncated calls, adversary not completed) degrades the run with its counts; a clean one stays COMPLETED. */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const fixture = () => structuredClone(agentFixtures().find(item => item.alias === 'NWCH')!);
const high = (proposal: any) => proposal.coverageProbe?.status === 'EXECUTED' && proposal.coverageProbe.diagnostic?.coverage?.level === 'HIGH' && !proposal.coverageProbe.diagnostic?.suspect?.value;
const contractOf = (proposal: any) => ({ id: proposal.proposalId, from: { db: proposal.from.db, table: proposal.from.table, column: proposal.from.column }, to: { db: proposal.to.db, table: proposal.to.table, column: proposal.to.column }, kind: 'FOREIGN_KEY' as const,
  reviewState: 'REVIEWED' as const, reviewOrigin: 'MODEL_REVIEWED' as const, identifierSpace: `nwch-${proposal.to.table}-${proposal.to.column}-v1`, normalization: 'text', normalizationVersion: 'text-exact-v1', normalizationLossless: true as const, normalizationAdapterCapability: 'exact-text' });
const judge = (status = 'VALID', call: object = { status: 'PASS', tokens: 10 }) => ({ judgeId: 'j1', status, call });
const adversary = (status: string, call: object = { status: 'PASS', tokens: 10 }) => ({ actor: 'a1', status, attacks: [], call });
/** Reviewer whose overlay carries `reviews` shaped like the real review run; `reviewOf` builds each review. */
const reviewer = (reviewOf: (id: string, index: number) => object): CandidateReview => async (request: CandidateReviewRequest) => {
  const approved = (request.proposals as any[]).filter(high);
  return { overlay: { schemaVersion: 1, kind: 'MODEL_REVIEW_OVERLAY', origin: 'MODEL_REVIEW', universe: request.universeId, label: 'revisado por modelo con pase adversarial', counts: { approved: approved.length }, notApproved: [],
    reviews: approved.map((item, index) => reviewOf(item.proposalId, index)) }, contracts: approved.map(contractOf) };
};
const run = (runId: string, candidateReview: CandidateReview, extra: Record<string, unknown> = {}) => { const f = fixture(); return runAgent('NWCH', runId, { ...offlineAgentDeps('NWCH', f, new Script([...f.chooserScript])), persist: false, critic: false, candidateReview, ...extra }) as Promise<any>; };

test('NWCH live-01 shape: every adversary call INVALID and truncated => DEGRADED with the codes and the counts', async () => {
  const report = await run('agent-health-1', reviewer(id => ({ relationId: id, evaluations: [judge()], adversary: adversary('INVALID', { status: 'PASS', tokens: 3000, truncated: true }), adversarialPass: 'INCOMPLETE' })));
  const codes = report.degradations.map((item: any) => item.code);
  assert.equal(report.status, 'DEGRADED');
  assert.ok(codes.includes(REVIEW_HEALTH_CODES.adversaryIncomplete) && codes.includes(REVIEW_HEALTH_CODES.callsInvalid), codes.join());
  const health = report.phases.candidateReview.health;
  assert.equal(health.adversary.incomplete, health.adversary.attempted);
  assert.ok(health.adversary.attempted >= 1 && health.truncatedCalls === health.adversary.attempted && health.invalidCalls === health.adversary.attempted);
  assert.deepEqual(health.thresholds, { maxInvalidCallShare: 0.25 });
});

test('a clean review (all calls valid, adversary completed) stays COMPLETED and reports zero counts', async () => {
  const report = await run('agent-health-2', reviewer(id => ({ relationId: id, evaluations: [judge(), judge()], adversary: adversary('COMPLETED'), adversarialPass: 'COMPLETED' })));
  assert.equal(report.status, 'COMPLETED');
  assert.ok(!report.degradations.some((item: any) => /^MODEL_REVIEW_/.test(item.code)));
  const health = report.phases.candidateReview.health;
  assert.deepEqual([health.invalidCalls, health.truncatedCalls, health.skippedBudgetCalls, health.adversary.incomplete, health.codes], [0, 0, 0, 0, []]);
});

test('cascade: calls skipped by the cascade are not calls: 30% INVALID among the REAL calls degrades even though the skipped ones would dilute it under 25%', () => {
  const skipped = () => ({ evaluations: [judge('SKIPPED_BY_CASCADE', { status: 'SKIPPED_BY_CASCADE', tokens: 0 })], adversary: adversary('SKIPPED_BY_CASCADE', { status: 'SKIPPED_BY_CASCADE', tokens: 0 }), adversarialPass: 'NOT_RUN' });
  const real = { evaluations: [judge(), judge(), judge('INVALID'), judge(), judge(), judge(), judge('INVALID'), judge(), judge(), judge('INVALID')], adversary: adversary('NOT_NEEDED'), adversarialPass: 'NOT_NEEDED' };
  const health = reviewHealthOf({ reviews: [real, ...Array.from({ length: 12 }, skipped)] });
  assert.deepEqual([health.calls, health.invalidCalls, health.skippedByCascadeCalls, health.invalidCallShare], [10, 3, 24, 0.3]);
  assert.deepEqual(health.codes, [REVIEW_HEALTH_CODES.callsInvalid]);
  assert.equal(health.adversary.attempted, 0, 'a cascaded adversary is not an attempted adversary');
});

test('reviewHealthOf: budget skips => PARTIAL_BUDGET; invalid share above the configured threshold => CALLS_INVALID, below => silent', () => {
  const skipped = reviewHealthOf({ reviews: [{ evaluations: [judge('SKIPPED_BUDGET', { status: 'SKIPPED_BUDGET', tokens: 0 })], adversary: adversary('NOT_NEEDED'), adversarialPass: 'NOT_RUN' }] });
  assert.deepEqual([skipped.codes, skipped.skippedBudgetCalls, skipped.calls], [[REVIEW_HEALTH_CODES.partialBudget], 1, 0]);
  const mixed = { reviews: [{ evaluations: [judge(), judge(), judge(), judge('INVALID')], adversary: adversary('COMPLETED'), adversarialPass: 'COMPLETED' }] };
  assert.deepEqual(reviewHealthOf(mixed).codes, [], '1 of 5 calls is 20%, under the default 25%');
  const strict = reviewHealthOf(mixed, { maxInvalidCallShare: 0.1 });
  assert.deepEqual([strict.codes, strict.invalidCalls, strict.calls, strict.invalidCallShare], [[REVIEW_HEALTH_CODES.callsInvalid], 1, 5, 0.2]);
});
