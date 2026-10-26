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

/** C5 (Round 10 full TPCDS run): pass 2 over pass 1's memory, with pass 1 PERSISTED in agent-runs (so the M7-2 prior exists), still reuses every approved pair. */
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
const reviewer = (log: { reusable: string[][]; reviewed: string[][] }): CandidateReview => async (request: CandidateReviewRequest) => {
  log.reusable.push(request.reusable ?? []);
  const chosen = (request.proposals as any[]).filter(high);
  log.reviewed.push(chosen.map(item => item.proposalId));
  return { overlay: { schemaVersion: 1, kind: 'MODEL_REVIEW_OVERLAY', origin: 'MODEL_REVIEW', universe: request.universeId, label: 'revisado por modelo con pase adversarial', counts: { approved: chosen.length }, notApproved: [] }, contracts: chosen.map(contractOf) };
};
const made: string[] = [];
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = path.join(fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')), 'LOCAL-SYNTHETIC'); made.push(path.dirname(dir)); return dir; };
const run = (runId: string, deps: Record<string, unknown>) => {
  made.push(path.join(ROOT, '.concordia', 'agent-runs', runId));
  const f = fixture();
  return runAgent('NWCH', runId, { ...offlineAgentDeps('NWCH', f, new Script([...f.chooserScript])), critic: false, now: () => '2026-10-25T00:00:00.000Z', ...deps }) as Promise<any>;
};

test('pass 2, with pass 1 persisted in agent-runs (coverAll), reuses every approved pair: no new contracts, memory WARM', async () => {
  const dir = scratch(), log = { reusable: [] as string[][], reviewed: [] as string[][] };
  const first = await run('agent-c5-reuse-1', { candidateReview: reviewer(log), memory: { dir } });
  const sustained = first.decisions.filter((d: any) => d.verdict === 'SOSTENIDA').map((d: any) => d.relationId).sort();
  assert.ok(sustained.length > 0, 'pass 1 approves at least one pair');
  assert.equal(first.postComa.policy.coverAll, true);
  assert.ok(fs.existsSync(path.join(ROOT, '.concordia', 'agent-runs', 'agent-c5-reuse-1', 'engine-run.json')), 'the prior is on disk');
  const second = await run('agent-c5-reuse-2', { candidateReview: reviewer(log), memory: { dir } });
  assert.equal(second.postComa.priorRun?.applied, true, 'the prior run was in force: the guard is real');
  assert.deepEqual(second.postComa.priorRun.skipped, [], 'coverAll: the prior skips nothing');
  assert.deepEqual([...log.reusable[1]!].sort(), sustained, 'the reviewer is told every approved pair is reusable');
  assert.deepEqual([...second.phases.candidateReview.reusedFromMemory].sort(), sustained, 'candidateReview.reused = N');
  assert.deepEqual(second.decisions.filter((d: any) => d.reasonCodes.includes('REUSED_FROM_MEMORY')).map((d: any) => d.relationId).sort(), sustained);
  assert.deepEqual(second.phases.candidateReview.applied ?? [], [], 'no new contracts');
  assert.equal(second.memory.reuse.mode, 'WARM');
  assert.equal(second.memory.reuse.reused.length, sustained.length);
  assert.ok(second.budget.used.queries < first.budget.used.queries);
});
