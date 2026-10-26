import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SecondaryJudgeChooser, SECONDARY_JUDGE_DEFAULT_ENABLED, measureJudge, parseJudgeChoice, shuffleSeeded, validateLabelledSet, type JudgeConfig, type SecondaryJudge } from '../src/agent/secondary-judge.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { limitsFromBounds, RunBudget } from '../src/agent/run-budget.ts';

const receipt = (model: string, tokens = 50) => ({ receiptId: `rcpt_${model}`, provider: 'p', model, inputTokens: tokens - 5, outputTokens: 5, totalTokens: tokens, latencyMs: 1, fromCache: false });
const call = (selected: string | undefined, decisionStatus = 'VALID', model = 'elector-model'): ChoiceCall =>
  ({ stage: 's1', status: 'PASS', decisionStatus, requestedModel: model, selected, receipt: receipt(model), promptHash: 'h1', utc: 'u' });
/** Elector that replays a script, one entry per call. */
function elector(script: ChoiceCall[]): ActionChooser & { calls: number } {
  const self = { calls: 0, async choose() { return script[Math.min(self.calls++, script.length - 1)]; } };
  return self;
}
function judge(answer: string | undefined, model = 'judge-model', status = 'PASS'): SecondaryJudge & { calls: number; seen: string[][] } {
  const self = { calls: 0, seen: [] as string[][], async judge(_q: string, ordered: readonly string[]) { self.calls++; self.seen.push([...ordered]); return { status, responseText: answer, receipt: receipt(model, 30) }; } };
  return self;
}
const cfg = (j: SecondaryJudge, over: Partial<JudgeConfig> = {}): JudgeConfig => ({ enabled: true, judge: j, budget: new RunBudget(limitsFromBounds({})), seedBase: 'run-1', ...over });
const ALLOWED = ['A', 'B', 'C'];

test('flag is OFF by default and a disabled wrapper is a pass-through that never calls the judge', async () => {
  assert.equal(SECONDARY_JUDGE_DEFAULT_ENABLED, false);
  const j = judge('{"choice":"B"}'), inner = elector([call('A')]);
  const result = await new SecondaryJudgeChooser(inner, cfg(j, { enabled: false, ambiguity: () => ({ tie: true, candidates: ['A', 'B'] }) })).choose('s1', {}, ALLOWED);
  assert.equal(result.secondaryJudge, undefined); assert.equal(result.selected, 'A'); assert.equal(j.calls, 0); assert.equal(inner.calls, 1);
});

test('no ambiguity: re-samples agree, the judge is not called', async () => {
  const j = judge('{"choice":"B"}'), inner = elector([call('A')]);
  const result = await new SecondaryJudgeChooser(inner, cfg(j, { k: 2 })).choose('s1', {}, ALLOWED);
  assert.equal(result.secondaryJudge?.status, 'NOT_AMBIGUOUS'); assert.equal(result.secondaryJudge?.signals.resamples, 2); assert.equal(j.calls, 0);
});

test('invalid elector id: the validator rejected it, so no re-sample and no judge', async () => {
  const j = judge('{"choice":"B"}'), inner = elector([call('ZZZ')]);
  const result = await new SecondaryJudgeChooser(inner, cfg(j, { ambiguity: () => ({ tie: true, candidates: ['A', 'B'] }) })).choose('s1', {}, ALLOWED);
  assert.equal(result.secondaryJudge, undefined); assert.equal(j.calls, 0); assert.equal(inner.calls, 1);
  const invalid = await new SecondaryJudgeChooser(elector([call('A', 'INVALID_RESPONSE')]), cfg(j, { ambiguity: () => ({ tie: true, candidates: ['A', 'B'] }) })).choose('s1', {}, ALLOWED);
  assert.equal(invalid.secondaryJudge, undefined);
});

test('re-sample disagreement triggers the judge; disagreement is a NOTE and never overwrites the selection', async () => {
  const j = judge('{"choice":"B"}'), inner = elector([call('A'), call('B'), call('A')]);
  const result = await new SecondaryJudgeChooser(inner, cfg(j, { k: 2 })).choose('s1', {}, ALLOWED);
  const note = result.secondaryJudge!;
  assert.equal(result.selected, 'A');
  assert.equal(note.status, 'DISAGREES'); assert.equal(note.judgeChoice, 'B'); assert.equal(note.label, 'NOTA_NO_DECISORIA');
  assert.equal(note.signals.trigger, 'RESAMPLE_DISAGREEMENT'); assert.deepEqual([...note.candidates!].sort(), ['A', 'B']);
  assert.equal(note.call?.receipt?.receiptId, 'rcpt_judge-model'); assert.equal(note.sameModelAsElector, false); assert.equal(j.calls, 1);
});

test('low margin and ties are free signals: the judge runs without any re-sample (cheap-first)', async () => {
  for (const ambiguity of [{ margin: 0.01, candidates: ['A', 'C'] }, { tie: true, candidates: ['A', 'C'] }]) {
    const j = judge('{"choice":"A"}'), inner = elector([call('A')]);
    const result = await new SecondaryJudgeChooser(inner, cfg(j, { marginThreshold: 0.1, ambiguity: () => ambiguity })).choose('s1', {}, ALLOWED);
    assert.equal(result.secondaryJudge?.status, 'AGREES'); assert.equal(inner.calls, 1); assert.equal(result.secondaryJudge?.signals.resamples, 0);
  }
  const high = await new SecondaryJudgeChooser(elector([call('A')]), cfg(judge('{"choice":"A"}'), { k: 0, marginThreshold: 0.1, ambiguity: () => ({ margin: 0.5, candidates: ['A', 'C'] }) })).choose('s1', {}, ALLOWED);
  assert.equal(high.secondaryJudge?.status, 'NOT_AMBIGUOUS');
});

test('the judge sees seeded random order, reproducible, and never the elector choice', async () => {
  const ids = ['A', 'B', 'C', 'D'];
  assert.deepEqual(shuffleSeeded(ids, 'seed-1'), shuffleSeeded(ids, 'seed-1'));
  assert.ok(['seed-1', 'seed-2', 'seed-3', 'seed-4', 'seed-5'].some(seed => shuffleSeeded(ids, seed).join() !== ids.join()));
  const j = judge('{"choice":"NONE"}');
  const result = await new SecondaryJudgeChooser(elector([call('A')]), cfg(j, { ambiguity: () => ({ tie: true, candidates: ['A', 'B', 'C'] }) })).choose('s1', { q: 1 }, ALLOWED);
  assert.equal(result.secondaryJudge?.status, 'ABSTAINED'); assert.deepEqual(j.seen[0], result.secondaryJudge?.candidates); assert.ok(result.secondaryJudge?.seed?.startsWith('run-1|s1'));
});

test('the judge answer is re-validated against the candidates it was shown', async () => {
  for (const answer of ['{"choice":"C"}', 'nope', '{"choice":"B","extra":1}']) {
    const result = await new SecondaryJudgeChooser(elector([call('A')]), cfg(judge(answer), { ambiguity: () => ({ tie: true, candidates: ['A', 'B'] }) })).choose('s1', {}, ALLOWED);
    assert.equal(result.secondaryJudge?.status, 'INVALID'); assert.equal(result.secondaryJudge?.judgeChoice, undefined); assert.equal(result.selected, 'A');
  }
  assert.deepEqual(parseJudgeChoice('{"choice":"NONE"}', ['A', 'B']), { ok: true, choice: 'NONE' });
});

test('a failing judge call is recorded, not retried, and does not change the selection', async () => {
  const j = judge(undefined, 'judge-model', 'FAIL');
  const result = await new SecondaryJudgeChooser(elector([call('A')]), cfg(j, { ambiguity: () => ({ tie: true, candidates: ['A', 'B'] }) })).choose('s1', {}, ALLOWED);
  assert.equal(result.secondaryJudge?.status, 'FAILED'); assert.equal(j.calls, 1); assert.equal(result.selected, 'A');
});

test('budget: no judge call when the pre-estimate does not fit', async () => {
  const budget = new RunBudget(limitsFromBounds({ maxTokensPerRun: 1000 })); budget.chargeTokens(990);
  const j = judge('{"choice":"B"}');
  const result = await new SecondaryJudgeChooser(elector([call('A')]), cfg(j, { budget, ambiguity: () => ({ tie: true, candidates: ['A', 'B'] }) })).choose('s1', {}, ALLOWED);
  assert.equal(result.secondaryJudge?.status, 'SKIPPED_BUDGET'); assert.equal(result.secondaryJudge?.call?.decisionStatus, 'TOKEN_BUDGET_WOULD_EXCEED'); assert.equal(j.calls, 0);
});

test('too few valid candidates: no judge', async () => {
  const j = judge('{"choice":"A"}');
  const result = await new SecondaryJudgeChooser(elector([call('A')]), cfg(j, { ambiguity: () => ({ tie: true, candidates: ['A', 'OUTSIDE'] }) })).choose('s1', {}, ALLOWED);
  assert.equal(result.secondaryJudge?.status, 'TOO_FEW_CANDIDATES'); assert.equal(j.calls, 0);
});

test('same model for elector and judge is flagged as a self-preference limitation', async () => {
  const result = await new SecondaryJudgeChooser(elector([call('A', 'VALID', 'm1')]), cfg(judge('{"choice":"A"}', 'm1'), { ambiguity: () => ({ tie: true, candidates: ['A', 'B'] }) })).choose('s1', {}, ALLOWED);
  assert.equal(result.secondaryJudge?.sameModelAsElector, true);
});

test('labelled-set harness: the example set validates and every figure has its denominator', () => {
  const set = JSON.parse(fs.readFileSync(new URL('./fixtures/secondary-judge-labelled-set.example.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateLabelledSet(set), []);
  const m = measureJudge(set);
  assert.equal(m.cases, 12); assert.equal(m.scored, 12); assert.equal(m.origins.LIVE, 0);
  assert.match(m.summary, /of 12 scored/); assert.match(m.summary, /no LIVE case: not evidence/);
  assert.equal(m.judgeCorrect + m.judgeInvalid <= m.scored, true);
  assert.deepEqual(validateLabelledSet({ schemaVersion: 1, cases: [{ id: 'x', question: 'q', candidates: ['A'], label: 'A', electorChoice: 'A', origin: 'LIVE' }] }), ['cases[0].candidates']);
});
