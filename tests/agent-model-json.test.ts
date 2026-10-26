import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GENERIC_CODE_PREFIX, parseAdaptiveChoice } from '../src/agent/chooser.ts';
import { parseJudgeChoice } from '../src/agent/secondary-judge.ts';
import { modelJsonText } from '../src/agent/model-json.ts';

const allowed = ['PROFILE_SS_ITEM_SK', 'STOP_EXPLORATION'];
const good = '{"action":"PROFILE_SS_ITEM_SK","reason":"item key range looks like a foreign key"}';
const parse = (text: string) => parseAdaptiveChoice(text, allowed, 500, false, GENERIC_CODE_PREFIX);

test('the literal agent-tpcds-live-02 response (one ```json block) is accepted', () => {
  const literal = fs.readFileSync(new URL('./fixtures/model-responses/tpcds-live-02-fenced.txt', import.meta.url), 'utf8');
  assert.match(literal, /^```json\r?\n/);
  assert.equal(parse(literal).action, 'PROFILE_SS_ITEM_SK');
});

test('exactly one fenced block, with or without the json tag and surrounding whitespace, is accepted; the legacy U2 prefix too', () => {
  for (const text of ['```json\n' + good + '\n```', '```\n' + good + '\n```', '\n  ```JSON\r\n' + good + '\r\n```  \n', '```' + good + '```'])
    assert.equal(parse(text).action, 'PROFILE_SS_ITEM_SK', text);
  assert.equal(parseAdaptiveChoice('```json\n' + good + '\n```', allowed).action, 'PROFILE_SS_ITEM_SK');
});

test('anything else stays NOT_JSON: two blocks, text before or after, another tag, bad JSON inside, unclosed fence', () => {
  const bad = ['```json\n' + good + '\n```\n```json\n' + good + '\n```', 'Here you go:\n```json\n' + good + '\n```', '```json\n' + good + '\n```\nDone.', '```python\n' + good + '\n```',
    '```json\n{"action": }\n```', '```json\n' + good, good + '```', '```json\n```'];
  for (const text of bad) assert.throws(() => parse(text), /MODEL_RESPONSE_NOT_JSON/, text);
});

test('the action is still validated against the allowed list inside a fence', () => {
  assert.throws(() => parse('```json\n{"action":"DROP_TABLE","reason":"a long enough reason"}\n```'), /MODEL_RESPONSE_INVALID/);
});

test('the critic assist and the secondary judge share the same fence rule', () => {
  assert.deepEqual(parseJudgeChoice('```json\n{"choice":"A"}\n```', ['A', 'B']), { ok: true, choice: 'A' });
  assert.deepEqual(parseJudgeChoice('x\n```json\n{"choice":"A"}\n```', ['A', 'B']), { ok: false });
  assert.equal(modelJsonText('no fence'), 'no fence');
});

test('an INVALID_RESPONSE keeps a sanitized excerpt (first 500 chars) on the call; a valid one does not', async () => {
  const { NightshiftChooser } = await import('../src/agent/chooser.ts');
  const { ROOT } = await import('../src/runtime.ts');
  const path = await import('node:path');
  const runId = 'agent-model-json-excerpt-test';
  const dir = path.join(ROOT, '.concordia', 'agent-runs', runId);
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    const reply = (text: string) => ({ route: 'fake', chat: async () => ({ text, receipt: undefined }) }) as any;
    const task = { productLabel: 'T', plannerTask: 'test' };
    const long = 'prose without json ' + 'x'.repeat(900);
    const bad = await new NightshiftChooser(reply(long), runId, task, GENERIC_CODE_PREFIX).choose('s', {}, allowed);
    assert.equal(bad.decisionStatus, 'INVALID_RESPONSE');
    assert.ok(bad.responseExcerpt && bad.responseExcerpt.length <= 500 && bad.responseExcerpt.startsWith('prose without json'));
    const ok = await new NightshiftChooser(reply('```json\n' + good + '\n```'), runId, task, GENERIC_CODE_PREFIX).choose('s', {}, allowed);
    assert.equal(ok.decisionStatus, 'VALID'); assert.equal(ok.responseExcerpt, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('N46: the prompt asks for a bare JSON object (no fence, no surrounding text) instead of relying on the retry', async () => {
  const { NightshiftChooser } = await import('../src/agent/chooser.ts');
  const { ROOT } = await import('../src/runtime.ts');
  const path = await import('node:path');
  const runId = 'agent-model-json-prompt-test', dir = path.join(ROOT, '.concordia', 'agent-runs', runId);
  let sent = '';
  try {
    const nightshift: any = { route: 'fake', chat: async (messages: any[]) => { sent = JSON.stringify(messages); return { text: good, receipt: undefined }; } };
    await new NightshiftChooser(nightshift, runId, { productLabel: 'T', plannerTask: 'test' }, GENERIC_CODE_PREFIX).choose('s', {}, allowed);
    assert.match(sent, /Bare JSON object: no Markdown code fence and no text before or after it./);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
