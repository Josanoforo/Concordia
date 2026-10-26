import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPackets, type ProbedProposalInput } from '../src/agent/model-review/evidence.ts';
import { normalizeToolArguments } from '../src/agent/model-review/normalize.ts';
import { parseAttacks, parseEvaluation } from '../src/agent/model-review/prompts.ts';
import { runModelReview } from '../src/agent/model-review/reviewer.ts';
import { StandInModel, attackAnswer, judgeAnswer } from '../src/agent/model-review/standin.ts';
import { TOOL_SCHEMA_VERSION, toolFor } from '../src/agent/model-review/tool-schemas.ts';
import type { ReviewCall, ReviewPacket, ReviewTraceEvent } from '../src/agent/model-review/types.ts';
import { RunBudget } from '../src/agent/run-budget.ts';

/**
 * R10b: a forced tool call can return an array/object field as a JSON string that holds it (live: 17 of 92 adversary answers read as INVALID). The arguments are read one level decoded, only
 * for a tool call, only when the decoded value has the type the schema declares, and the record says so. Anything else stays INVALID with no retry. All offline.
 */
const budget = () => new RunBudget({ maxQueriesPerRun: 5, readLimit: 50, maxTokensPerRun: 5_000_000, maxSteps: 3 });
const proposal: ProbedProposalInput = {
  proposalId: 'web_sales.ws_bill_customer_sk__customer.c_customer_sk', from: { table: 'web_sales', column: 'ws_bill_customer_sk' }, to: { table: 'customer', column: 'c_customer_sk' },
  coverageProbe: { status: 'EXECUTED', diagnostic: { coverage: { level: 'HIGH', matched: 5, probed: 5, threshold: 0.8 },
    multiplicity: { from: { rows: 5, distinctKeys: 5, maxRowsPerKey: 1 }, to: { rows: 5, distinctKeys: 5, maxRowsPerKey: 1 } },
    keyRules: { inclusion: { status: 'NO_VIOLATION_IN_SAMPLE', missingCount: 0 }, targetUniqueness: { status: 'NO_DUPLICATES_IN_SAMPLE' } } } }
};
const packet = (): ReviewPacket => buildPackets([proposal], { minDistinctKeys: 3, universeId: 'T' }).packets[0]!;
const receipt = { receiptId: 'r', provider: 'p', model: 'm', inputTokens: 1000, outputTokens: 238, totalTokens: 1238, latencyMs: 1, fromCache: false };
const toolCall = (text: string, transport: ReviewCall['transport'] | null): ReviewCall => ({ status: 'PASS', responseText: text, receipt, ...(transport ? { transport } : {}) });
const relationOf = (messages: readonly { content: string }[]) => JSON.parse(messages[1]!.content).packet.relationId as string;
const none = (family: string) => ({ family, severity: 'none', recommend: 'keep', argument: '', evidenceRefs: [] });
const attacks = (extra: Record<string, unknown> = {}) => [none('HOMONYM'), { family: 'SIBLING', severity: 'minor', recommend: 'keep', argument: 'ws_ship_customer_sk is a role sibling', evidenceRefs: ['target.table', 'coverage'], ...extra }];

async function run(adversaryText: (relationId: string) => string, transport: ReviewCall['transport'] | null = 'TOOL_CALL', judgeText?: (relationId: string, messages: readonly { content: string }[]) => string) {
  const events: ReviewTraceEvent[] = [];
  const judge = (id: string) => new StandInModel(id, messages => toolCall(judgeText ? judgeText(relationOf(messages), messages) : judgeAnswer('SEMANTIC', JSON.parse(messages[1]!.content).packet), transport));
  const adversary = new StandInModel('adversary', messages => toolCall(adversaryText(relationOf(messages)), transport));
  const result = await runModelReview({ packets: [packet()], judges: [judge('judge-a'), judge('judge-b')], adversary, budget: budget(), config: { minDistinctKeys: 3 }, onEvent: event => events.push(event) });
  return { result, review: result.reviews[0]!, events, adversary };
}
const row = (result: Awaited<ReturnType<typeof run>>['result'], role: string) => result.modelTable.find(item => item.role === role)!;

test('the live case: attacks as a JSON string in a tool call is a valid adversary answer with two attacks', async () => {
  const text = (id: string) => JSON.stringify({ relationId: id, attacks: JSON.stringify(attacks()) });
  const { result, review, events, adversary } = await run(text);
  assert.equal(review.adversary.status, 'COMPLETED');
  assert.equal(review.adversarialPass, 'COMPLETED');
  assert.equal(review.decision, 'accept', 'two non-blocking attacks leave the accept standing');
  assert.deepEqual(review.adversary.attacks.filter(attack => attack.source === 'MODEL').map(attack => attack.family), ['HOMONYM', 'SIBLING']);
  assert.equal(adversary.calls, 1, 'one call: a normalized answer is neither invalid nor retried');
  assert.deepEqual(review.adversary.call?.normalized, ['attacks:json-string']);
  assert.equal(JSON.parse(review.adversary.call!.responseText!).attacks.constructor, String, 'the response text stays verbatim, as the model sent it');
  const parse = events.find(event => event.kind === 'model-review-parse' && event.stage === 'ATTACK');
  assert.equal(parse?.parseStatus, 'VALID');
  assert.deepEqual(parse?.normalized, ['attacks:json-string']);
  assert.deepEqual([row(result, 'adversary').normalizedCalls, row(result, 'adversary').invalid, row(result, 'judge-a').normalizedCalls], [1, 0, 0], 'health counts it on the adversary row only');
});

test('the exact answer recorded live (a role sibling with three references) is valid too', async () => {
  const live = '{"relationId":"web_sales.ws_bill_customer_sk__customer.c_customer_sk","attacks":"[{\\"family\\":\\"HOMONYM\\",\\"severity\\":\\"none\\",\\"recommend\\":\\"keep\\",\\"argument\\":\\"\\",\\"evidenceRefs\\":[]},{\\"family\\":\\"SIBLING\\",\\"severity\\":\\"minor\\",\\"recommend\\":\\"keep\\",\\"argument\\":\\"ws_ship_customer_sk is a role sibling\\",\\"evidenceRefs\\":[\\"tieBreak\\",\\"roles\\",\\"siblings[5]\\"]}]"}';
  const { review } = await run(() => live);
  assert.equal(review.adversary.status, 'COMPLETED');
  assert.equal(review.adversary.attacks.filter(attack => attack.source === 'MODEL').length, 2);
  assert.deepEqual(review.adversary.call?.normalized, ['attacks:json-string']);
});

test('without the tool call (message text, or a tool call that answered in text) the same answer stays INVALID', async () => {
  const text = (id: string) => JSON.stringify({ relationId: id, attacks: JSON.stringify(attacks()) });
  for (const transport of ['TEXT', null] as const) {
    const { review, result } = await run(text, transport);
    assert.equal(review.adversary.status, 'INVALID', String(transport));
    assert.equal(review.decision, 'defer');
    assert.equal(review.adversary.call?.normalized, undefined);
    assert.equal(row(result, 'adversary').normalizedCalls, 0);
  }
});

test('a string that does not parse, or parses to the wrong type, is INVALID (no retry, nothing recorded as normalized)', async () => {
  const wrong: [string, unknown][] = [
    ['not JSON', 'attacks: HOMONYM none, SIBLING minor'],
    ['truncated JSON', JSON.stringify(attacks()).slice(0, -3)],
    ['an object where an array is declared', JSON.stringify({ HOMONYM: none('HOMONYM'), SIBLING: none('SIBLING') })],
    ['a number', '5'],
    ['a JSON string holding a string (decoded once only)', JSON.stringify(JSON.stringify(attacks()))],
    ['an empty string', '']
  ];
  for (const [name, value] of wrong) {
    const { review, adversary, result } = await run(id => JSON.stringify({ relationId: id, attacks: value }));
    assert.equal(review.adversary.status, 'INVALID', name);
    assert.equal(review.decision, 'defer', name);
    assert.equal(adversary.calls, 1, `${name}: no retry`);
    assert.equal(review.adversary.call?.normalized, undefined, name);
    assert.equal(row(result, 'adversary').invalid, 1, name);
    assert.equal(row(result, 'adversary').normalizedCalls, 0, name);
  }
});

test('a decoded array that the strict parser refuses is still INVALID: the schema is checked after decoding, never relaxed', async () => {
  const bad: [string, unknown[]][] = [
    ['one entry', [none('HOMONYM')]],
    ['a repeated family', [none('HOMONYM'), none('HOMONYM')]],
    ['an extra key on an entry', [none('HOMONYM'), { ...none('SIBLING'), note: 'x' }]],
    ['an unknown severity', [none('HOMONYM'), { ...none('SIBLING'), severity: 'huge' }]]
  ];
  for (const [name, value] of bad) {
    const { review } = await run(id => JSON.stringify({ relationId: id, attacks: JSON.stringify(value) }));
    assert.equal(review.adversary.status, 'INVALID', name);
    assert.equal(review.adversary.call?.normalized, undefined, name);
  }
  const wrongRelation = await run(() => JSON.stringify({ relationId: 'x.y__z.w', attacks: JSON.stringify(attacks()) }));
  assert.equal(wrongRelation.review.adversary.status, 'INVALID', 'the relation id is still checked');
  const extraField = await run(id => JSON.stringify({ relationId: id, attacks: JSON.stringify(attacks()), verdict: 'accept' }));
  assert.equal(extraField.review.adversary.status, 'INVALID', 'a field the schema does not have is still refused');
});

test('a string-encoded field inside an entry (evidenceRefs) is read decoded too, each place once', async () => {
  const entries = attacks().map(item => ({ ...item, evidenceRefs: JSON.stringify(item.evidenceRefs) }));
  const { review } = await run(id => JSON.stringify({ relationId: id, attacks: entries }));
  assert.equal(review.adversary.status, 'COMPLETED');
  assert.deepEqual(review.adversary.call?.normalized, ['attacks[0].evidenceRefs:json-string', 'attacks[1].evidenceRefs:json-string']);
  const both = await run(id => JSON.stringify({ relationId: id, attacks: JSON.stringify(entries) }));
  assert.equal(both.review.adversary.status, 'COMPLETED');
  assert.deepEqual(both.review.adversary.call?.normalized, ['attacks:json-string', 'attacks[0].evidenceRefs:json-string', 'attacks[1].evidenceRefs:json-string']);
  assert.equal(both.result.modelTable.find(item => item.role === 'adversary')!.normalizedCalls, 1, 'a call counts once however many fields were decoded');
});

test('a blocking attack that arrives as a string still has to be grounded to sustain: normalization raises nothing', async () => {
  const blocking = [{ family: 'HOMONYM', severity: 'blocking', recommend: 'reject', argument: 'other entity', evidenceRefs: ['siblings[9]'] }, none('SIBLING')];
  const { review } = await run(id => JSON.stringify({ relationId: id, attacks: JSON.stringify(blocking) }));
  assert.equal(review.adversary.status, 'COMPLETED');
  assert.equal(review.adversary.attacks.find(attack => attack.source === 'MODEL' && attack.family === 'HOMONYM')?.outcome, 'UNGROUNDED', 'the reference is not in the packet');
  assert.equal(review.decision, 'accept');
  const grounded = [{ family: 'HOMONYM', severity: 'blocking', recommend: 'reject', argument: 'other entity', evidenceRefs: ['target.table'] }, none('SIBLING')];
  const sustained = await run(id => JSON.stringify({ relationId: id, attacks: JSON.stringify(grounded) }));
  assert.equal(sustained.review.decision, 'reject', 'a grounded blocking attack in a string lowers the decision exactly as an array would');
  assert.deepEqual(sustained.review.adversary.call?.normalized, ['attacks:json-string']);
});

test('judges: reasonCodes as a JSON string is read decoded, with the same rules', async () => {
  const answer = (relationId: string, messages: readonly { content: string }[], over: Record<string, unknown> = {}) => {
    const parsed = JSON.parse(judgeAnswer('SEMANTIC', JSON.parse(messages[1]!.content).packet));
    return JSON.stringify({ ...parsed, relationId, ...over, reasonCodes: over.reasonCodes ?? JSON.stringify(parsed.reasonCodes) });
  };
  const { result, review } = await run(attackText, 'TOOL_CALL', (id, messages) => answer(id, messages));
  assert.deepEqual(review.evaluations.map(item => item.status), ['VALID', 'VALID']);
  assert.deepEqual(review.evaluations.map(item => item.call?.normalized), [['reasonCodes:json-string'], ['reasonCodes:json-string']]);
  assert.equal(review.decision, 'accept');
  assert.deepEqual([row(result, 'judge-a').normalizedCalls, row(result, 'judge-b').normalizedCalls, row(result, 'judge-a').invalid], [1, 1, 0]);
  for (const [name, reasonCodes] of [['not JSON', 'KEY_MEMBERSHIP_COMPLETE, TARGET_UNIQUE_IN_SAMPLE'], ['unknown code', JSON.stringify(['NOT_A_CODE'])], ['an object', JSON.stringify({ a: 1 })], ['empty list', '[]']] as const) {
    const refused = await run(attackText, 'TOOL_CALL', (id, messages) => answer(id, messages, { reasonCodes }));
    assert.deepEqual(refused.review.evaluations.map(item => item.status), ['INVALID', 'INVALID'], name);
    assert.equal(row(refused.result, 'judge-a').normalizedCalls, 0, name);
  }
  const text = await run(attackText, 'TEXT', (id, messages) => answer(id, messages));
  assert.deepEqual(text.review.evaluations.map(item => item.status), ['INVALID', 'INVALID'], 'message text is never decoded');
});
function attackText(relationId: string) { return JSON.stringify({ relationId, attacks: attacks().map(item => ({ ...item, severity: 'none', recommend: 'keep', argument: '', evidenceRefs: [] })) }); }

test('the normalizer is driven by the tool schema, changes nothing else and never throws', () => {
  const direct = JSON.stringify({ relationId: 'a', attacks: attacks() });
  assert.deepEqual(normalizeToolArguments('ATTACK', direct), { text: direct, normalized: [] }, 'a well-formed answer comes back untouched, byte for byte');
  for (const junk of ['', 'not json', '[1,2]', '"x"', 'null', '{"attacks":']) assert.deepEqual(normalizeToolArguments('ATTACK', junk), { text: junk, normalized: [] }, junk);
  const encoded = normalizeToolArguments('ATTACK', JSON.stringify({ relationId: 'a', attacks: JSON.stringify(attacks()) }));
  assert.deepEqual(JSON.parse(encoded.text), { relationId: 'a', attacks: attacks() });
  assert.deepEqual(encoded.normalized, ['attacks:json-string']);
  // A string where the schema declares a string is left alone, even if it looks like JSON; the same field under the other stage's schema is not touched.
  const rationale = JSON.stringify({ relationId: 'a', decision: 'defer', confidence: 'low', reasonCodes: ['NAME_AMBIGUOUS'], rationale: '[1,2]' });
  assert.deepEqual(normalizeToolArguments('EVALUATION', rationale), { text: rationale, normalized: [] });
  assert.deepEqual(normalizeToolArguments('EVALUATION', JSON.stringify({ relationId: 'a', attacks: JSON.stringify(attacks()) })).normalized, [], 'attacks is not a field of the evaluation schema');
  // Fenced output (as the parsers already accept) is read the same way.
  assert.deepEqual(normalizeToolArguments('ATTACK', '```json\n' + JSON.stringify({ relationId: 'a', attacks: JSON.stringify(attacks()) }) + '\n```').normalized, ['attacks:json-string']);
  // The strict parsers are untouched: they still refuse the encoded form on their own.
  assert.equal(parseAttacks(JSON.stringify({ relationId: 'a', attacks: JSON.stringify(attacks()) }), 'a'), undefined);
  assert.equal(parseAttacks(encoded.text, 'a')?.length, 2);
  assert.equal(parseEvaluation(JSON.stringify({ relationId: 'a', decision: 'defer', confidence: 'low', reasonCodes: JSON.stringify(['NAME_AMBIGUOUS']), rationale: 'r' }), 'a'), undefined);
});

test('the tool schemas say "array, not a string" and are a new schema version; the prompt version, and so N2, is untouched', () => {
  assert.equal(TOOL_SCHEMA_VERSION, 'model-review-tools-v2');
  const attacksField = (toolFor('ATTACK').function.parameters as any).properties.attacks;
  assert.match(attacksField.description, /array.*not a string/i);
  assert.match((attacksField.items.properties.evidenceRefs as any).description, /array/i);
  assert.match((toolFor('EVALUATION').function.parameters as any).properties.reasonCodes.description, /array/i);
  assert.equal(attackAnswer(packet()).includes('"attacks":['), true, 'the offline stand-ins keep answering with real arrays');
});
