import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent, extendedProfileOf, tieBreakEnabled, tieBreakResolverOf } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { offlineAgentDeps } from '../src/agent/offline-deps.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { ROOT } from '../src/runtime.ts';

/** E1-03 resume of post-COMA + the final-run engine fixes (tie-break gate, F1x field). */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const made: string[] = [];
test.after(() => { for (const id of made) fs.rmSync(path.join(ROOT, '.concordia', 'agent-runs', id), { recursive: true, force: true }); });
const run = (runId: string, extra: Record<string, unknown> = {}) => {
  made.push(runId);
  const f = structuredClone(agentFixtures().find(item => item.alias === 'NWCH')!);
  return runAgent('NWCH', runId, { ...offlineAgentDeps('NWCH', f, new Script([...f.chooserScript])), critic: false, postComaPrior: false, codeSha: 'sha-test', now: () => '2026-10-25T00:00:00.000Z', ...extra }) as Promise<any>;
};
const dirOf = (id: string) => path.join(ROOT, '.concordia', 'agent-runs', id);
const verdicts = (report: any) => report.decisions.map((d: any) => [d.relationId, d.verdict]).sort();
const journalOf = (id: string) => path.join(dirOf(id), 'post-coma-journal.jsonl');

test('an interrupted run resumed with the same SHA gives the same verdicts and spends no SQL on the journaled probes', async () => {
  const reference = await run('agent-resume-ref');
  assert.ok(fs.readFileSync(journalOf('agent-resume-ref'), 'utf8').split('\n').filter(Boolean).length >= 2, 'the post-COMA journal holds at least one probe');
  await run('agent-resume-int');
  const lines = fs.readFileSync(journalOf('agent-resume-int'), 'utf8').split('\n').filter(Boolean), kept = Math.max(1, Math.floor((lines.length - 1) / 2));
  // The power cut: no engine-run.json, half the probes journaled, the last line torn.
  fs.rmSync(path.join(dirOf('agent-resume-int'), 'engine-run.json'));
  fs.writeFileSync(journalOf('agent-resume-int'), [...lines.slice(0, 1 + kept), '{"kind":"PROBE","propo'].join('\n'));
  const resumed = await run('agent-resume-int', { resume: { runId: 'agent-resume-int' } });
  assert.deepEqual(verdicts(resumed), verdicts(reference));
  assert.equal(resumed.resume.resumedProbes, kept);
  assert.equal(resumed.resume.resumedProbes + resumed.resume.newProbes, lines.length - 1);
  assert.equal(resumed.resume.interruptions, 1);
  assert.ok(resumed.budget.used.queries < reference.budget.used.queries, 'the journaled probes cost no queries');
});

test('RESUMED_AFTER_INTERRUPTION is informational: listed, never DEGRADED by itself', async () => {
  const reference = await run('agent-resume-info-ref');
  await run('agent-resume-info');
  fs.rmSync(path.join(dirOf('agent-resume-info'), 'engine-run.json'));
  const resumed = await run('agent-resume-info', { resume: { runId: 'agent-resume-info' } });
  assert.ok(resumed.degradations.some((d: any) => d.code === 'RESUMED_AFTER_INTERRUPTION'));
  assert.equal(resumed.status, reference.status);
});

test('a finished run is never reopened: RUN_ALREADY_COMPLETE; other bad resumes are refused before anything runs', async () => {
  await run('agent-resume-done');
  await assert.rejects(run('agent-resume-done', { resume: { runId: 'agent-resume-done' } }), /RUN_ALREADY_COMPLETE/);
  await assert.rejects(run('agent-resume-missing', { resume: { runId: 'agent-resume-missing' } }), /RESUME_RUN_NOT_FOUND/);
  await assert.rejects(run('agent-resume-done', { resume: { runId: 'agent-other' } }), /RESUME_RUN_ID_MISMATCH/);
  await assert.rejects(run('agent-resume-nopersist', { resume: { runId: 'agent-resume-nopersist' }, persist: false }), /RESUME_REQUIRES_PERSIST/);
});

test('a resume under another SHA is refused by the journal header (POST_COMA_RESUME_MISMATCH)', async () => {
  await run('agent-resume-sha');
  fs.rmSync(path.join(dirOf('agent-resume-sha'), 'engine-run.json'));
  await assert.rejects(run('agent-resume-sha', { resume: { runId: 'agent-resume-sha' }, codeSha: 'another-sha' }), /POST_COMA_RESUME_MISMATCH/);
});

test('manifest switches: tie-break is off by default; F1x has its own field and fullEvidence true does not turn it on', () => {
  assert.equal(tieBreakEnabled({}), false); assert.equal(tieBreakEnabled({ tieBreak: { enabled: true } }), true); assert.equal(tieBreakEnabled({ tieBreak: { enabled: 'true' } }), false);
  assert.equal(extendedProfileOf({ fullEvidence: true }), false); assert.equal(extendedProfileOf({ fullEvidenceExtendedProfile: true }), true);
});

test('the review tie-break resolver orders a group with X10 steps over the profiles the run measured, and answers nothing for a lone candidate', () => {
  const ep = (table: string) => ({ db: 'D', table, column: 'id' });
  const proposals = ['a', 'b'].map(id => ({ proposalId: id, from: ep('src'), to: ep(`t_${id}`), coverageProbe: { status: 'EXECUTED', diagnostic: { coverage: { level: 'HIGH' }, suspect: { value: false } } } }));
  const cache = { entries: new Map(), pending: new Map(), stats: { queries: 0, hits: 0 } } as any;
  const put = (table: string, distinct: number) => cache.entries.set(`${table}.id`, { profile: { table, column: 'id', provenance: 'GLOBAL_WHOLE_TABLE', form: 'F1', rows: 100, distinct, nulls: 0 }, query: {} });
  put('t_a', 100); put('t_b', 40);
  const resolve = tieBreakResolverOf({ profileCache: cache }, proposals);
  const answer = resolve(['a', 'b'])!;
  assert.deepEqual(answer.ordered, ['a', 'b'], 'the globally unique target ranks first');
  assert.equal(typeof answer.decisive, 'boolean');
  assert.equal(resolve(['a']), undefined);
});
