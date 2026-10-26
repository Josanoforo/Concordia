import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { choiceToolRequest, GENERIC_CODE_PREFIX, LEGACY_U2_CODE_PREFIX, NightshiftChooser } from '../src/agent/chooser.ts';
import { ROOT } from '../src/runtime.ts';

const allowed = ['READ_CUSTOMER_PROFILE', 'STOP_EXPLORATION'];
const task = { productLabel: 'T', plannerTask: 'test' };
const runId = 'agent-chooser-tool-call-test';
const cleanup = () => fs.rmSync(path.join(ROOT, '.concordia', 'agent-runs', runId), { recursive: true, force: true });
const fake = (replies: string[]) => {
  const seen: any[] = [];
  return { seen, nightshift: { route: 'fake', chat: async (_m: any[], options: any) => { seen.push(options); return { text: replies.shift() ?? '', receipt: { model: 'fake', totalTokens: 100 } as any, toolCall: { name: 'choose_action' } }; } } as any };
};

test('N1: the generic chooser forces a tool call whose action is an enum of the allowed ids; the legacy prefix sends none', async () => {
  const request = choiceToolRequest(allowed, false) as any;
  assert.deepEqual(request.tools[0].function.parameters.properties.action.enum, allowed);
  assert.equal(request.toolChoice.function.name, request.tools[0].function.name);
  assert.equal(choiceToolRequest(allowed, true).tools.length, 1);
  try {
    const generic = fake(['{"action":"READ_CUSTOMER_PROFILE","reason":"bounded read next"}']);
    const call = await new NightshiftChooser(generic.nightshift, runId, task, GENERIC_CODE_PREFIX).choose('s', {}, allowed);
    assert.equal(call.selected, 'READ_CUSTOMER_PROFILE');
    assert.deepEqual((generic.seen[0].tools[0] as any).function.parameters.properties.action.enum, allowed);
    assert.ok(generic.seen[0].toolChoice);
    const legacy = fake(['{"action":"STOP_EXPLORATION","reason":"nothing more useful"}']);
    await new NightshiftChooser(legacy.nightshift, runId, task, LEGACY_U2_CODE_PREFIX).choose('s', {}, allowed);
    assert.equal(legacy.seen[0].tools, undefined);
    assert.equal(generic.nightshift.route, 'fake');
  } finally { cleanup(); }
});

test('N1: an invalid tool reply keeps M7-1 (one retry, still with the tool) and the estimate counts the schema', async () => {
  try {
    const { nightshift, seen } = fake(['not json', '{"action":"STOP_EXPLORATION","reason":"nothing more useful"}']);
    const chooser = new NightshiftChooser(nightshift, runId, task, GENERIC_CODE_PREFIX);
    const call = await chooser.choose('s', {}, allowed, { canRetry: () => true });
    assert.equal(call.attempt, 2); assert.equal(call.selected, 'STOP_EXPLORATION'); assert.equal(seen.length, 2);
    assert.ok(seen.every(options => options.tools && options.toolChoice));
    const plain = new NightshiftChooser(nightshift, runId, task, GENERIC_CODE_PREFIX, 'NONE');
    assert.ok(chooser.estimateTokens('s', {}, allowed) > plain.estimateTokens('s', {}, allowed));
  } finally { cleanup(); }
});
