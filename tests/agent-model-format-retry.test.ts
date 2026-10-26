import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FORMAT_REMINDER, GENERIC_CODE_PREFIX, NightshiftChooser } from '../src/agent/chooser.ts';
import { runAgent } from '../src/agent/engine.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { NightshiftChatError } from '../src/clients/nightshift.ts';
import { readJson, ROOT } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

const allowed = ['READ_CUSTOMER_PROFILE', 'STOP_EXPLORATION'];
const good = '{"action":"READ_CUSTOMER_PROFILE","reason":"customer profile is the next bounded read"}';
const task = { productLabel: 'T', plannerTask: 'test' };
const receipt = (totalTokens: number) => ({ model: 'fake', totalTokens }) as any;
type Reply = string | { transport: true } | { text: string; tokens: number };
function fake(replies: Reply[]) {
  const seen: { messages: any[] }[] = [];
  const nightshift: any = { route: 'fake', chat: async (messages: any[]) => {
    seen.push({ messages });
    const next = replies.shift() ?? 'STOP';
    if (typeof next === 'object' && 'transport' in next) throw new NightshiftChatError('NIGHTSHIFT_TIMEOUT', undefined, undefined, undefined, 'att-1');
    const text = typeof next === 'string' ? next : next.text;
    return { text, receipt: receipt(typeof next === 'string' ? 100 : next.tokens) };
  } };
  return { nightshift, seen };
}
const runId = 'agent-model-format-retry-test';
const cleanup = () => fs.rmSync(path.join(ROOT, '.concordia', 'agent-runs', runId), { recursive: true, force: true });
const choose = async (replies: Reply[], canRetry?: (tokens: number) => boolean) => {
  const { nightshift, seen } = fake(replies);
  try { return { call: await new NightshiftChooser(nightshift, runId, task, GENERIC_CODE_PREFIX).choose('s', {}, allowed, { canRetry }), generations: seen.length, seen }; } finally { cleanup(); }
};

test('1. NOT_JSON then a valid reply: exactly one retry with the format reminder, valid, tokens of both generations charged', async () => {
  const { call, generations, seen } = await choose(['no json at all', good], () => true);
  assert.equal(generations, 2);
  assert.equal(call.decisionStatus, 'VALID'); assert.equal(call.selected, 'READ_CUSTOMER_PROFILE'); assert.equal(call.attempt, 2);
  assert.equal(seen[1]!.messages.at(-1).content, FORMAT_REMINDER);
  assert.equal(call.tokensCharged, 200);
  assert.deepEqual(call.formatRetry, { attempted: true, originalCode: 'MODEL_RESPONSE_NOT_JSON', outcome: 'VALID' });
  assert.equal(call.firstAttempt?.errorCode, 'MODEL_RESPONSE_NOT_JSON');
});

test('2. NOT_JSON twice: no third attempt, the call stays INVALID_RESPONSE (today\'s degradation)', async () => {
  const { call, generations } = await choose(['prose', 'still prose', good], () => true);
  assert.equal(generations, 2);
  assert.equal(call.decisionStatus, 'INVALID_RESPONSE'); assert.equal(call.attempt, 2);
  assert.equal(call.formatRetry?.outcome, 'INVALID_RESPONSE');
});

test('3. a valid decision is never retried', async () => {
  const { call, generations } = await choose([good], () => true);
  assert.equal(generations, 1); assert.equal(call.attempt, 1); assert.equal(call.formatRetry, undefined);
});

test('4. a disallowed action is not retried (valid JSON, wrong action)', async () => {
  const { call, generations } = await choose(['{"action":"DROP_TABLE","reason":"a long enough reason"}'], () => true);
  assert.equal(generations, 1); assert.equal(call.decisionStatus, 'INVALID_RESPONSE');
  assert.equal((call.error as any).code, 'MODEL_RESPONSE_INVALID'); assert.equal(call.formatRetry, undefined);
});

test('5. a transport error is not retried', async () => {
  const { call, generations } = await choose([{ transport: true }], () => true);
  assert.equal(generations, 1); assert.equal(call.status, 'FAIL'); assert.equal(call.formatRetry, undefined);
});

test('6. without budget for the retry: no retry, with the reason; no budget context at all also means no retry', async () => {
  const noBudget = await choose(['prose', good], () => false);
  assert.equal(noBudget.generations, 1); assert.deepEqual(noBudget.call.formatRetry, { attempted: false, reason: 'TOKEN_BUDGET_WOULD_EXCEED', originalCode: 'MODEL_RESPONSE_NOT_JSON' });
  const noContext = await choose(['prose', good]);
  assert.equal(noContext.generations, 1); assert.equal(noContext.call.formatRetry?.reason, 'NO_BUDGET_CONTEXT');
});

test('a transport failure during the retry degrades as today without a third attempt', async () => {
  const { call, generations } = await choose(['prose', { transport: true }], () => true);
  assert.equal(generations, 2); assert.equal(call.status, 'FAIL'); assert.equal(call.formatRetry?.outcome, 'TRANSPORT_FAIL'); assert.equal(call.tokensCharged, 100);
});

test('in a run: NOT_JSON then valid counts both generations in the run budget and the model participates (USED)', async () => {
  const fx = readJson('eval/agent/AGENTFX.json') as any;
  const { nightshift } = fake(['prose', { text: good, tokens: 150 }, { text: '{"action":"STOP_EXPLORATION","reason":"nothing else is useful"}', tokens: 100 }]);
  const id = 'agent-agentfx-format-retry-test';
  try {
    const report: any = await runAgent('AGENTFX', id, { client: fixtureClient(universeConfig('AGENTFX'), fx.tables) as any, chooser: new NightshiftChooser(nightshift, id, task, GENERIC_CODE_PREFIX), executionMode: 'LIVE', dataOrigin: 'SYNTHETIC', persist: false, critic: false, modelRequested: true } as any);
    assert.equal(report.modelParticipation, 'USED');
    assert.equal(report.budget.used.tokens, 100 + 150 + 100, 'first generation 100 + retry 150 + next decision 100');
    assert.equal(report.phases.exploration.calls[0].attempt, 2);
  } finally { fs.rmSync(path.join(ROOT, '.concordia', 'agent-runs', id), { recursive: true, force: true }); }
});
