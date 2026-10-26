import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import type { CandidateReview, CandidateReviewRequest } from '../src/agent/model-review-contract.ts';
import { createReviewDecisionMemory, readReviewDecisionLedger } from '../src/agent/review-decision-memory.ts';
import { offlineAgentDeps } from '../src/agent/offline-deps.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { ROOT } from '../src/runtime.ts';

/** N2: negative memory of the model review. A reject/defer is remembered by (relation, evidence fingerprint, prompt version) and is never an approval. */
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

interface Knobs { promptVersion?: string; salt?: Record<string, string>; approve?: string[]; rejectWhen?: (id: string, index: number) => boolean }
interface Log { modelCalls: string[]; rejected: string[]; approved: string[]; hits: string[] }
/** Stand-in for X8: odd-indexed HIGH candidates are rejected (unless `approve` names them), each consults the memory first and a model call is counted only on a miss. */
const reviewer = (log: Log, knobs: Knobs = {}): CandidateReview => async (request: CandidateReviewRequest) => {
  const memory = request.reviewDecisionMemory, pv = knobs.promptVersion ?? 'prompt-v1';
  const chosen = (request.proposals as any[]).filter(high).sort((a, b) => a.proposalId.localeCompare(b.proposalId));
  const rejectWhen = knobs.rejectWhen ?? ((_id: string, index: number) => index % 2 === 1);
  const approved: any[] = [], notApproved: any[] = [], fresh: any[] = [];
  chosen.forEach((proposal, index) => {
    const id = proposal.proposalId as string, fingerprint = `fp:${id}${knobs.salt?.[id] ?? ''}`;
    if (!rejectWhen(id, index) || knobs.approve?.includes(id)) { approved.push(proposal); return; }
    const hit = memory?.lookup(id, fingerprint, pv);
    if (hit) { log.hits.push(id); notApproved.push({ relationId: id, decision: hit.decision, reasons: hit.reasons, reviewed: false }); return; }
    log.modelCalls.push(id);
    notApproved.push({ relationId: id, decision: 'reject', reasons: ['ATTACK'], reviewed: true });
    fresh.push({ relationId: id, decision: 'reject', reasons: ['ATTACK'], evidenceFingerprint: fingerprint, promptVersion: pv, models: ['judge-a', 'adversary-b'] });
  });
  memory?.record(fresh);
  log.rejected.push(...notApproved.map(item => item.relationId)); log.approved.push(...approved.map(item => item.proposalId));
  return { overlay: { schemaVersion: 1, kind: 'MODEL_REVIEW_OVERLAY', origin: 'MODEL_REVIEW', universe: request.universeId, label: 'revisado por modelo con pase adversarial', counts: { approved: approved.length }, notApproved }, contracts: approved.map(contractOf) };
};
const newLog = (): Log => ({ modelCalls: [], rejected: [], approved: [], hits: [] });
const made: string[] = [];
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const scratch = () => { const dir = path.join(fs.mkdtempSync(path.join(ROOT, '.concordia', 'agent-memory-test-')), 'LOCAL-SYNTHETIC'); made.push(path.dirname(dir)); return dir; };
const run = (runId: string, deps: Record<string, unknown>) => { const f = fixture(); return runAgent('NWCH', runId, { ...offlineAgentDeps('NWCH', f, new Script([...f.chooserScript])), persist: false, critic: false, ...deps }) as Promise<any>; };
const sustainedOf = (result: any) => result.decisions.filter((d: any) => d.verdict === 'SOSTENIDA').map((d: any) => d.relationId).sort();

test('pass 2 on pass 1 memory with unchanged evidence: 0 model calls for the non-approved, same decisions, counters in engine-run memory', async () => {
  const dir = scratch(), first = newLog(), second = newLog();
  const one = await run('agent-n2-same-1', { candidateReview: reviewer(first), memory: { dir } });
  assert.ok(first.modelCalls.length >= 1, 'the fixture has HIGH candidates the review rejects');
  assert.equal(one.memory.reviewDecisions.recorded, first.modelCalls.length);
  assert.equal(one.memory.reviewDecisions.reused, 0);
  const two = await run('agent-n2-same-2', { candidateReview: reviewer(second), memory: { dir } });
  assert.deepEqual(second.modelCalls, [], '0 model calls for what pass 1 did not approve');
  assert.deepEqual(second.hits.sort(), [...first.modelCalls].sort());
  assert.deepEqual(sustainedOf(two), sustainedOf(one), 'same decisions');
  assert.deepEqual(two.memory.reviewDecisions, { reused: first.modelCalls.length, recorded: 0, invalidated: 0, reusedIds: [...first.modelCalls].sort(), invalidatedIds: [] });
  assert.equal(readReviewDecisionLedger(dir).length, first.modelCalls.length, 'nothing is written twice');
});

test('changed evidence in one relation: only that one is reviewed again (history kept); changed promptVersion: all are', async () => {
  const dir = scratch(), first = newLog();
  await run('agent-n2-inv-1', { candidateReview: reviewer(first), memory: { dir } });
  const rejected = [...first.modelCalls].sort();
  assert.ok(rejected.length >= 1);
  const changed = newLog(), two = await run('agent-n2-inv-2', { candidateReview: reviewer(changed, { salt: { [rejected[0]!]: '-new-evidence' } }), memory: { dir } });
  assert.deepEqual(changed.modelCalls, [rejected[0]], 'only the relation with new evidence is reviewed again');
  assert.equal(two.memory.reviewDecisions.invalidated, 1);
  assert.equal(two.memory.reviewDecisions.reused, rejected.length - 1);
  assert.equal(two.memory.reviewDecisions.recorded, 1);
  const ledger = readReviewDecisionLedger(dir).filter(entry => entry.relationId === rejected[0]);
  assert.equal(ledger.length, 2, 'the old decision stays as history: append-only');
  assert.notEqual(ledger[0]!.evidenceFingerprint, ledger[1]!.evidenceFingerprint);
  const version = newLog(), three = await run('agent-n2-inv-3', { candidateReview: reviewer(version, { promptVersion: 'prompt-v2' }), memory: { dir } });
  assert.deepEqual(version.modelCalls.sort(), rejected, 'a new prompt version reviews all again');
  assert.equal(three.memory.reviewDecisions.reused, 0);
  assert.equal(three.memory.reviewDecisions.invalidated, rejected.length);
});

test('a previous reject never blocks a later approval with new evidence, and the approval retires the old no', async () => {
  const dir = scratch(), first = newLog();
  const one = await run('agent-n2-flip-1', { candidateReview: reviewer(first), memory: { dir } });
  const target = [...first.modelCalls].sort()[0]!;
  assert.ok(!sustainedOf(one).includes(target));
  const second = newLog(), two = await run('agent-n2-flip-2', { candidateReview: reviewer(second, { salt: { [target]: '-better-evidence' }, approve: [target] }), memory: { dir } });
  assert.ok(sustainedOf(two).includes(target), 'approved with the new evidence');
  assert.ok(second.approved.includes(target));
  // The old evidence comes back and the review rejects again: the retired "no" does not answer for it, it is reviewed again.
  const third = newLog();
  await run('agent-n2-flip-3', { candidateReview: reviewer(third), memory: { dir } });
  assert.ok(third.modelCalls.includes(target) && !third.hits.includes(target), 'the retired reject is not reused');
});

test('negative memory is never an approval: no SOSTENIDA, no reused approvals, no HUMAN claim, origin sealed MODEL_REVIEWED', async () => {
  const dir = scratch(), first = newLog(), second = newLog();
  await run('agent-n2-inv-seal-1', { candidateReview: reviewer(first), memory: { dir } });
  const two = await run('agent-n2-inv-seal-2', { candidateReview: reviewer(second), memory: { dir } });
  const rejected = new Set(first.modelCalls);
  assert.ok(rejected.size >= 1);
  assert.ok(two.decisions.every((d: any) => !rejected.has(d.relationId)), 'a remembered no yields no decision');
  assert.ok(two.memory.reuse.reused.every((item: any) => !rejected.has(item.relationId)), 'not in the approvals reused');
  assert.ok(two.memory.claims.every((claim: any) => !rejected.has(claim.relationId) && claim.reviewOrigin !== 'HUMAN_REVIEWED'), 'no HUMAN claim touched');
  const ledger = readReviewDecisionLedger(dir);
  assert.ok(ledger.every(entry => entry.origin === 'MODEL_REVIEWED' && entry.executionMode === 'LOCAL' && entry.dataOrigin === 'SYNTHETIC'));
  assert.ok(ledger.every(entry => entry.decision === 'reject' || entry.decision === 'defer'));
});

test('unit: an entry sealed with another origin is ignored; a malformed record is dropped; an approval marker is never a hit', () => {
  const dir = scratch();
  const make = (origin: { executionMode: string; dataOrigin: string }) => createReviewDecisionMemory({ universeId: 'NWCH', dir, origin, runId: 'r1', now: () => '2026-10-26T00:00:00.000Z' });
  const local = make({ executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' });
  local.record([{ relationId: 'a', decision: 'defer', reasons: ['X'], evidenceFingerprint: 'f', promptVersion: 'p' }, { relationId: 'b', decision: 'reject', reasons: [], evidenceFingerprint: '', promptVersion: 'p' }, { relationId: 'c', decision: 'approve' as any, reasons: [], evidenceFingerprint: 'f', promptVersion: 'p' }]);
  assert.equal(local.stats().recorded, 1);
  assert.equal(local.lookup('a', 'f', 'p')?.decision, 'defer');
  assert.equal(local.lookup('a', 'f', 'other'), null);
  local.approve(['a']);
  assert.equal(local.lookup('a', 'f', 'p'), null);
  const file = path.join(dir, 'review-decisions.jsonl');
  const entry = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]!);
  fs.appendFileSync(file, JSON.stringify({ ...entry, relationId: 'z', executionMode: 'LIVE', dataOrigin: 'PUBLIC' }) + '\n');
  assert.equal(local.lookup('z', 'f', 'p'), null, 'another origin is ignored');
});
