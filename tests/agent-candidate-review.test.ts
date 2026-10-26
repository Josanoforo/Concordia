import test from 'node:test';
import { FULL_EVIDENCE_MAX_QUERIES } from '../src/probe/full-evidence.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import type { CandidateReview, CandidateReviewRequest } from '../src/agent/model-review-contract.ts';
import { offlineAgentDeps } from '../src/agent/offline-deps.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { ROOT } from '../src/runtime.ts';

/** R-1: the model reviews the blind post-COMA candidates BEFORE the contract probes; the accepted ones become MODEL_REVIEWED contracts applied inside the run, probed, decided by the unchanged policy and sealed. */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const fixture = () => structuredClone(agentFixtures().find(item => item.alias === 'NWCH')!);
const RUNS = path.join(ROOT, '.concordia', 'agent-runs'), cleanups: string[] = [];
test.after(() => { for (const dir of cleanups) fs.rmSync(dir, { recursive: true, force: true }); });
const high = (proposal: any) => proposal.coverageProbe?.status === 'EXECUTED' && proposal.coverageProbe.diagnostic?.coverage?.level === 'HIGH' && !proposal.coverageProbe.diagnostic?.suspect?.value;
const contractOf = (proposal: any) => ({ id: proposal.proposalId, from: { db: proposal.from.db, table: proposal.from.table, column: proposal.from.column }, to: { db: proposal.to.db, table: proposal.to.table, column: proposal.to.column }, kind: 'FOREIGN_KEY' as const,
  reviewState: 'REVIEWED' as const, reviewOrigin: 'MODEL_REVIEWED' as const, identifierSpace: `nwch-${proposal.to.table}-${proposal.to.column}-v1`, normalization: 'text', normalizationVersion: 'text-exact-v1', normalizationLossless: true as const, normalizationAdapterCapability: 'exact-text', label: 'revisado por modelo con pase adversarial' });
/** A scripted reviewer: accepts the first `take` HIGH-coverage unsuspected candidates. */
const reviewer = (take: number, seen: CandidateReviewRequest[] = []): CandidateReview => async request => {
  seen.push(request);
  const chosen = (request.proposals as any[]).filter(high).slice(0, take);
  request.budget.chargeTokens(100);
  return { overlay: { schemaVersion: 1, kind: 'MODEL_REVIEW_OVERLAY', origin: 'MODEL_REVIEW', universe: request.universeId, label: 'revisado por modelo con pase adversarial', counts: { candidates: request.proposals.length, approved: chosen.length }, notApproved: [] }, contracts: chosen.map(contractOf) };
};
const run = (runId: string, deps: Record<string, unknown> = {}) => { const f = fixture(); cleanups.push(path.join(RUNS, runId)); return runAgent('NWCH', runId, { ...offlineAgentDeps('NWCH', f, new Script([...f.chooserScript])), persist: false, critic: false, ...deps }) as Promise<any>; };

test('R-1 run: the accepted candidates are applied, probed and decided by the policy, sealed MODEL_REVIEWED in verdict and memory, and the stage saw the post-COMA proposals', async () => {
  const seen: CandidateReviewRequest[] = [], dir = path.join(fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')), 'LOCAL-SYNTHETIC');
  cleanups.push(path.dirname(dir));
  const report = await run('agent-r1-run', { candidateReview: reviewer(2, seen), memory: { dir } });
  const section = report.phases.candidateReview;
  assert.equal(seen.length, 1); assert.ok(seen[0]!.proposals.length > 0 && Object.keys(seen[0]!.tableColumns).length === 6);
  assert.equal(section.status, 'APPLIED'); assert.equal(section.applied.length, 2);
  const mine = report.decisions.filter((d: any) => section.applied.includes(d.relationId));
  assert.equal(mine.length, 2, 'one verdict per applied contract');
  assert.ok(mine.every((d: any) => d.reviewOrigin === 'MODEL_REVIEWED' && typeof d.verdict === 'string'), JSON.stringify(mine));
  assert.equal(section.estimate.units, 2); assert.equal(section.estimate.perUnit.queries, 2 + FULL_EVIDENCE_MAX_QUERIES, 'NWCH declares fullEvidence: PROBE_QUERY_COST 2 + FULL_EVIDENCE_MAX_QUERIES');
  assert.ok(report.budget.phases.byPhase.modelReview.used.tokens >= 100, 'the reviewer tokens land in the modelReview phase');
  const claims = report.memory.claims.filter((c: any) => section.applied.includes(c.relationId));
  assert.ok(claims.length > 0 && claims.every((c: any) => c.reviewOrigin === 'MODEL_REVIEWED'));
});

test('R-1 run: the model contracts decide nothing alone: verdicts of the blind run without a reviewer stay empty, and nothing is applied when nothing is approved', async () => {
  const none = await run('agent-r1-none', { candidateReview: reviewer(0) });
  assert.equal(none.phases.candidateReview.status, 'NOTHING_APPROVED');
  assert.deepEqual(none.decisions, []);
});

test('R-1 run: persist writes model-review-overlay.json with origin MODEL_REVIEW and the report names its hash', async () => {
  const report = await run('agent-r1-persist', { candidateReview: reviewer(1), persist: true });
  const file = path.join(RUNS, 'agent-r1-persist', 'model-review-overlay.json');
  const overlay = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(overlay.origin, 'MODEL_REVIEW');
  assert.equal(report.phases.candidateReview.overlayFile, 'model-review-overlay.json'); assert.match(report.phases.candidateReview.overlaySha256, /^[0-9a-f]{64}$/);
});

test('R-1 run: a missing reviewer is listed (and degrades a LIVE run), a failing one or an invalid contract degrades the run; a contract that claims a human origin is refused', async () => {
  const missing = await run('agent-r1-missing');
  assert.equal(missing.phases.candidateReview.status, 'SKIPPED_NO_REVIEWER'); assert.ok(missing.degradations.some((d: any) => d.code === 'MODEL_REVIEW_UNAVAILABLE'));
  assert.equal(missing.status, 'COMPLETED', 'an offline baseline of a MODEL_ADVERSARIAL universe runs blind on purpose: listed, not degraded');
  const failing = await run('agent-r1-fail', { candidateReview: async () => { throw new Error('x'); } });
  assert.equal(failing.phases.candidateReview.status, 'FAILED'); assert.equal(failing.status, 'DEGRADED');
  const forged = await run('agent-r1-forged', { candidateReview: async (request: CandidateReviewRequest) => ({ overlay: { origin: 'MODEL_REVIEW' }, contracts: [{ ...contractOf((request.proposals as any[]).find(high)), id: 'not.a.proposal__of.this.run' }] }) });
  assert.deepEqual([forged.phases.candidateReview.status, forged.phases.candidateReview.error.code], ['FAILED', 'MODEL_REVIEW_OUTPUT_INVALID']);
  const standIn = await run('agent-r1-standin', { executionMode: 'LIVE', candidateReview: async (request: CandidateReviewRequest) => { const out = await reviewer(1)(request); return { ...out, overlay: { ...out.overlay, provenance: 'STAND_IN_OFFLINE' } }; } });
  assert.deepEqual([standIn.phases.candidateReview.status, standIn.phases.candidateReview.error.code, standIn.phases.candidateReview.applied], ['FAILED', 'MODEL_REVIEW_STAND_IN_IN_LIVE_RUN', []]);
  assert.equal(standIn.decisions.length, 0, 'nothing from a stand-in is applied in a LIVE run');
  const humanOrigin = await run('agent-r1-human', { candidateReview: async (request: CandidateReviewRequest) => ({ overlay: { origin: 'MODEL_REVIEW' }, contracts: [{ ...contractOf((request.proposals as any[]).find(high)), reviewOrigin: 'HUMAN_REVIEWED' as any }] }) });
  assert.equal(humanOrigin.phases.candidateReview.status, 'FAILED', 'a contract that claims a human origin is refused');
});
