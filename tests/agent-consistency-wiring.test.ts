import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import type { CandidateReview, CandidateReviewRequest } from '../src/agent/model-review-contract.ts';
import { offlineAgentDeps } from '../src/agent/offline-deps.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';

/** E2-03 wiring: X10's consistency pass runs between the review and the contract probes; a demoted edge gets no contract and carries rule + winner; off by default; never a verdict change. */
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
const reviewer: CandidateReview = async (request: CandidateReviewRequest) => {
  const approved = (request.proposals as any[]).filter(high);
  return { overlay: { schemaVersion: 1, kind: 'MODEL_REVIEW_OVERLAY', origin: 'MODEL_REVIEW', universe: request.universeId, label: 'revisado por modelo con pase adversarial', counts: { approved: approved.length }, notApproved: [] }, contracts: approved.map(contractOf) };
};
const run = (runId: string, extra: Record<string, unknown>) => { const f = fixture(); return runAgent('NWCH', runId, { ...offlineAgentDeps('NWCH', f, new Script([...f.chooserScript])), persist: false, critic: false, candidateReview: reviewer, ...extra }) as Promise<any>; };

test('off by default: the pass is not called and the section says OFF', async () => {
  let called = 0;
  const report = await run('agent-cons-1', { consistency: { enforce: ((edges: any[]) => { called++; return { kept: edges, demoted: [], unresolved: [] }; }) as any } });
  assert.equal(called, 0);
  assert.deepEqual(report.phases.candidateReview.consistency, { status: 'OFF' });
});

test('enabled: a demoted edge gets no contract, no probe and no verdict; its rule and winner are in the section, the overlay trace and notApproved', async () => {
  const seen: any[] = [];
  const baseline = await run('agent-cons-2', {}), all = baseline.phases.candidateReview.approved as string[];
  assert.ok(all.length >= 2);
  const loser = all[0]!, winner = all[1]!;
  const report = await run('agent-cons-3', { consistency: { enabled: true, enforce: ((edges: any[]) => { seen.push(edges); return { kept: edges.filter(e => e.id !== loser), demoted: [{ edge: edges.find(e => e.id === loser), rule: 'FK_ONCE', winner, reason: 'test' }], unresolved: [] }; }) as any } });
  const section = report.phases.candidateReview;
  assert.equal(seen.length, 1);
  assert.ok(seen[0].every((e: any) => e.reachesHigh === true && e.from.table && e.to.table));
  assert.ok(!section.approved.includes(loser) && !section.applied.includes(loser));
  assert.deepEqual(section.consistency.demoted, [{ id: loser, rule: 'FK_ONCE', winner, reason: 'test' }]);
  assert.ok(section.notApproved.some((n: any) => n.relationId === loser && n.reasons.includes('CONSISTENCY_FK_ONCE') && n.reviewed === true));
  assert.ok(!report.decisions.some((d: any) => d.relationId === loser), 'no contract, so no decision');
  assert.ok(report.decisions.some((d: any) => d.relationId === winner));
});

test('enabled but the pass throws (fail closed): every edge stays, the section says ERROR and the run is DEGRADED', async () => {
  const report = await run('agent-cons-4', { consistency: { enabled: true, enforce: (() => { throw new Error('boom'); }) as any } });
  assert.equal(report.phases.candidateReview.consistency.status, 'ERROR');
  assert.equal(report.status, 'DEGRADED');
  assert.ok(report.degradations.some((d: any) => d.code === 'CONSISTENCY_FAILED'));
  assert.ok(report.decisions.length > 0);
});
