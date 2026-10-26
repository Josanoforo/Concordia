import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestCounterProbes, DEFAULT_COUNTERPROBE_CATALOG, FRINGE_COUNTERPROBE_ID, type AssistChooser, type SustainedRelation } from '../src/agent/critic-assist.ts';
import { limitsFromBounds, RunBudget } from '../src/agent/run-budget.ts';
import type { TypedCriticOutcome } from '../src/critic/adversarial.ts';

const sustained: SustainedRelation[] = [{ relationId: 'r1', from: 'A.a', to: 'B.b' }, { relationId: 'r2', from: 'C.c', to: 'D.d' }];
const receipt = { receiptId: 'rcpt_x', provider: 'p', model: 'm', inputTokens: 100, outputTokens: 20, totalTokens: 120, latencyMs: 1, fromCache: false };
const scripted = (text: string | undefined, status = 'PASS'): AssistChooser & { calls: number } => {
  const chooser = { calls: 0, async suggest() { chooser.calls++; return { status, responseText: text, receipt }; } };
  return chooser;
};
const outcome = (status: TypedCriticOutcome['status']) => async (): Promise<TypedCriticOutcome> => ({ status, reason: `scripted ${status}` });
const budget = (bounds = {}) => new RunBudget(limitsFromBounds(bounds));
const pick = (...items: object[]) => JSON.stringify({ counterprobes: items });

test('valid id runs through the critic rule and degrades; others stay untouched', async () => {
  const b = budget(), chooser = scripted(pick({ relationId: 'r1', id: FRINGE_COUNTERPROBE_ID }, { relationId: 'r2', id: FRINGE_COUNTERPROBE_ID }));
  const run: string[] = [];
  const result = await suggestCounterProbes({ sustained, catalog: DEFAULT_COUNTERPROBE_CATALOG, budget: b, chooser,
    execute: async (relationId) => { run.push(relationId); return { status: relationId === 'r1' ? 'DEGRADED' : 'CONFIRMED', reason: 'scripted' }; } });
  assert.equal(result.status, 'ASSISTED');
  assert.equal(chooser.calls, 1);
  assert.deepEqual(run, ['r1', 'r2']);
  assert.deepEqual(result.degradedRelationIds, ['r1']);
  assert.equal(result.executed.find(item => item.relationId === 'r2')!.degraded, false);
  assert.equal(result.call.receipt?.receiptId, 'rcpt_x'); assert.equal(result.call.decisionStatus, 'VALID');
  assert.equal(b.tokens, 120);
  assert.ok(result.labels.includes('DEGRADE_ONLY'));
});

test('an id outside the catalog is rejected with its reason and never executed', async () => {
  const chooser = scripted(pick({ relationId: 'r1', id: 'DROP_TABLE_X' }, { relationId: 'zz', id: FRINGE_COUNTERPROBE_ID }, { relationId: 'r1', id: FRINGE_COUNTERPROBE_ID }, { relationId: 'r1', id: FRINGE_COUNTERPROBE_ID }, 7 as any));
  let executed = 0;
  const result = await suggestCounterProbes({ sustained, catalog: DEFAULT_COUNTERPROBE_CATALOG, budget: budget(), chooser, execute: async () => { executed++; return { status: 'CONFIRMED', reason: 'ok' }; } });
  assert.deepEqual(result.rejected.map(item => item.reason), ['UNKNOWN_COUNTERPROBE_ID', 'UNKNOWN_RELATION', 'DUPLICATE', 'MALFORMED_ITEM']);
  assert.equal(executed, 1);
  assert.deepEqual(result.suggested, [{ relationId: 'r1', id: FRINGE_COUNTERPROBE_ID }]);
  assert.deepEqual(result.degradedRelationIds, []);
});

test('only invalid ids: no execution, labelled fallback to the deterministic critic', async () => {
  const result = await suggestCounterProbes({ sustained, catalog: DEFAULT_COUNTERPROBE_CATALOG, budget: budget(), chooser: scripted(pick({ relationId: 'r1', id: 'NOPE' })), execute: outcome('DEGRADED') });
  assert.equal(result.status, 'NO_VALID_SUGGESTION'); assert.equal(result.fallback?.to, 'DETERMINISTIC_CRITIC'); assert.equal(result.executed.length, 0);
});

test('invalid or failed model falls back without retry', async () => {
  for (const [text, status, expected] of [['not json', 'PASS', 'INVALID_RESPONSE'], ['{"counterprobes":"x"}', 'PASS', 'INVALID_RESPONSE'], [undefined, 'FAIL', 'MODEL_CALL_FAILED']] as const) {
    const chooser = scripted(text, status);
    const result = await suggestCounterProbes({ sustained, catalog: DEFAULT_COUNTERPROBE_CATALOG, budget: budget(), chooser, execute: outcome('DEGRADED') });
    assert.equal(result.status, 'FALLBACK_DETERMINISTIC'); assert.equal(result.call.decisionStatus, expected);
    assert.equal(result.fallback?.reason, expected); assert.equal(chooser.calls, 1); assert.equal(result.executed.length, 0);
  }
});

test('exhausted token budget makes no model call', async () => {
  const b = budget({ maxTokensPerRun: 1000 }); b.chargeTokens(990);
  const chooser = scripted('{"counterprobes":[]}');
  const result = await suggestCounterProbes({ sustained, catalog: DEFAULT_COUNTERPROBE_CATALOG, budget: b, chooser, execute: outcome('DEGRADED') });
  assert.equal(result.status, 'SKIPPED_BUDGET'); assert.equal(chooser.calls, 0); assert.equal(result.call.made, false);
  assert.equal(result.fallback?.reason, 'TOKEN_BUDGET_WOULD_EXCEED'); assert.equal(result.call.decisionStatus, 'TOKEN_BUDGET_WOULD_EXCEED');
});

test('exhausted SQL budget skips execution but keeps the call and receipt', async () => {
  const b = budget({ maxQueriesPerRun: 1 });
  let executed = 0;
  const result = await suggestCounterProbes({ sustained, catalog: DEFAULT_COUNTERPROBE_CATALOG, budget: b, chooser: scripted(pick({ relationId: 'r1', id: FRINGE_COUNTERPROBE_ID })),
    execute: async () => { executed++; return { status: 'DEGRADED', reason: 'x' }; } });
  assert.equal(executed, 0); assert.equal(result.executed[0].status, 'SKIPPED_BUDGET'); assert.equal(result.call.receipt?.receiptId, 'rcpt_x'); assert.deepEqual(result.degradedRelationIds, []);
});

test('no sustained relations: nothing is called', async () => {
  const chooser = scripted('{}');
  const result = await suggestCounterProbes({ sustained: [], catalog: DEFAULT_COUNTERPROBE_CATALOG, budget: budget(), chooser, execute: outcome('DEGRADED') });
  assert.equal(result.status, 'NO_SUSTAINED'); assert.equal(chooser.calls, 0);
});

test('an executor that throws is an ERROR outcome and cannot degrade', async () => {
  const result = await suggestCounterProbes({ sustained, catalog: DEFAULT_COUNTERPROBE_CATALOG, budget: budget(), chooser: scripted(pick({ relationId: 'r1', id: FRINGE_COUNTERPROBE_ID })),
    execute: async () => { throw new Error('boom'); } });
  assert.equal(result.executed[0].status, 'ERROR'); assert.deepEqual(result.degradedRelationIds, []);
});
