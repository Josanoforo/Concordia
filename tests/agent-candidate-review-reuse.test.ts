import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import type { CandidateReview, CandidateReviewRequest } from '../src/agent/model-review-contract.ts';
import { offlineAgentDeps } from '../src/agent/offline-deps.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { ROOT } from '../src/runtime.ts';

/** R-1 warm start: a MODEL_REVIEWED SOSTENIDA that memory still holds (seal and mode satisfied, version current, inside the TTL) is reused instead of probed again. */
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
/** Accepts every HIGH candidate; `reject` names ones it reviews and does not approve. Records what it was told was reusable. */
const reviewer = (log: { reusable: string[][]; reviewed: string[][] }, reject: string[] = []): CandidateReview => async (request: CandidateReviewRequest) => {
  log.reusable.push(request.reusable ?? []);
  const chosen = (request.proposals as any[]).filter(high);
  const approved = chosen.filter(item => !reject.includes(item.proposalId));
  log.reviewed.push(chosen.map(item => item.proposalId));
  return { overlay: { schemaVersion: 1, kind: 'MODEL_REVIEW_OVERLAY', origin: 'MODEL_REVIEW', universe: request.universeId, label: 'revisado por modelo con pase adversarial', counts: { approved: approved.length },
    notApproved: reject.map(relationId => ({ relationId, decision: 'reject', reasons: ['ATTACK'], reviewed: true })) }, contracts: approved.map(contractOf) };
};
const made: string[] = [];
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = path.join(fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')), 'LOCAL-SYNTHETIC'); made.push(path.dirname(dir)); return dir; };
const run = (runId: string, deps: Record<string, unknown>) => { const f = fixture(); return runAgent('NWCH', runId, { ...offlineAgentDeps('NWCH', f, new Script([...f.chooserScript])), persist: false, critic: false, ...deps }) as Promise<any>; };

test('R-1 warm start: the second run reuses the first run SOSTENIDA contracts from memory with their MODEL_REVIEWED seal and probes only what is new', async () => {
  const dir = scratch(), log = { reusable: [] as string[][], reviewed: [] as string[][] };
  const first = await run('agent-r1-reuse-1', { candidateReview: reviewer(log), memory: { dir } });
  const sustained = first.decisions.filter((d: any) => d.verdict === 'SOSTENIDA').map((d: any) => d.relationId).sort();
  assert.ok(sustained.length > 0, 'the first run sustains at least one model contract');
  assert.deepEqual(log.reusable[0], [], 'nothing is reusable on a cold start');
  const second = await run('agent-r1-reuse-2', { candidateReview: reviewer(log), memory: { dir } });
  assert.deepEqual([...log.reusable[1]!].sort(), sustained, 'the reviewer is told which candidates memory can reuse');
  const reused = second.decisions.filter((d: any) => d.reasonCodes.includes('REUSED_FROM_MEMORY'));
  assert.deepEqual(reused.map((d: any) => d.relationId).sort(), sustained);
  assert.ok(reused.every((d: any) => d.verdict === 'SOSTENIDA' && d.reviewOrigin === 'MODEL_REVIEWED' && d.from?.table && d.to?.table), JSON.stringify(reused));
  assert.deepEqual([...second.phases.candidateReview.reusedFromMemory].sort(), sustained);
  assert.ok(second.phases.candidateReview.probed?.every((id: string) => !sustained.includes(id)) ?? true, 'reused contracts are not probed again');
  assert.ok(second.budget.used.queries < first.budget.used.queries, `fewer queries on the second run: ${second.budget.used.queries} < ${first.budget.used.queries}`);
  assert.ok(second.memory.reuse.reused.length >= sustained.length);
});

test('R-1 warm start: a candidate the review looks at again and does not approve is NOT reused; and without memory nothing is reused', async () => {
  const dir = scratch(), log = { reusable: [] as string[][], reviewed: [] as string[][] };
  const first = await run('agent-r1-reuse-3', { candidateReview: reviewer(log), memory: { dir } });
  const sustained = first.decisions.filter((d: any) => d.verdict === 'SOSTENIDA').map((d: any) => d.relationId).sort();
  const dropped = sustained[0]!;
  const second = await run('agent-r1-reuse-4', { candidateReview: reviewer(log, [dropped]), memory: { dir } });
  const reusedIds = second.decisions.filter((d: any) => d.reasonCodes.includes('REUSED_FROM_MEMORY')).map((d: any) => d.relationId);
  assert.ok(!reusedIds.includes(dropped), 'a rejected-now candidate gets no reuse');
  assert.ok(!second.decisions.some((d: any) => d.relationId === dropped), 'and no contract');
  const cold = await run('agent-r1-reuse-5', { candidateReview: reviewer(log) });
  assert.equal(cold.decisions.filter((d: any) => d.reasonCodes.includes('REUSED_FROM_MEMORY')).length, 0);
});
