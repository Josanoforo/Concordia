import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { measureJudgeOffline } from '../scripts/m8-6-judge-tpcds-offline.ts';

const proposal = (id: string, suspect: boolean) => ({ proposalId: id, coverageProbe: { status: 'EXECUTED', diagnostic: { suspect: { value: suspect, reasons: suspect ? ['LOW_COVERAGE'] : [] }, labels: { signal: 'NOT_COMPARABLE' }, coverage: { level: suspect ? 'LOW' : 'HIGH' }, keyRules: { inclusion: { status: 'UNKNOWN' }, targetUniqueness: { status: 'UNKNOWN' } }, governance: 'CANDIDATE_REQUIRES_REVIEW' } } });

test('M8-6: the offline judge measurement replays synthetic run artifacts with zero model calls and an ineligible invalid elector call', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm8-6-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (run: string, body: object) => { fs.mkdirSync(path.join(dir, run)); fs.writeFileSync(path.join(dir, run, 'engine-run.json'), JSON.stringify(body)); };
  write('r1', { status: 'COMPLETED', postComa: { proposals: [proposal('a', true), proposal('b', false), { proposalId: 'c' }] }, phases: { exploration: { calls: [], plannerError: { code: 'TOKEN_BUDGET_WOULD_EXCEED' } } } });
  write('r2', { status: 'DEGRADED_NO_MODEL', modelParticipation: 'FAILED', postComa: { proposals: [proposal('b', false), proposal('d', true)] },
    phases: { exploration: { calls: [{ stage: 's', decisionStatus: 'INVALID_RESPONSE', receipt: { totalTokens: 10 } }] } } });
  const result = await measureJudgeOffline(dir, ['r1', 'r2']);
  assert.equal(result.mode, 'OFFLINE_REPLAY');
  assert.deepEqual(result.modelCalls, { judge: 0, elector: 0, tokensSpentByThisScript: 0 });
  assert.equal(result.runs.r1.proposals, 3); assert.equal(result.runs.r1.executedCoverageProbes, 2); assert.equal(result.runs.r1.deterministicDiagnosis.suspect.true, 1);
  assert.equal(result.runs.r1.electorCalls, 0); assert.equal(result.runs.r2.electorValid, 0);
  assert.equal(result.runs.r2.electorReplay[0].judgeNote, 'NOT_ELIGIBLE'); assert.equal(result.runs.r2.suspectOrNotComparable, 2);
  assert.deepEqual(result.overlapExecutedCandidates, { r1: 2, r2: 2, common: 1 });
  assert.match(result.labelledSet.measurement, /NOT_COMPUTABLE/);
});
