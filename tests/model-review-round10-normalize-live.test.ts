import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildPackets, type ProbedProposalInput } from '../src/agent/model-review/evidence.ts';
import { normalizeToolArguments } from '../src/agent/model-review/normalize.ts';
import { parseAttacks, parseEvaluation } from '../src/agent/model-review/prompts.ts';
import { runModelReview } from '../src/agent/model-review/reviewer.ts';
import { StandInModel, judgeAnswer } from '../src/agent/model-review/standin.ts';
import type { ReviewCall } from '../src/agent/model-review/types.ts';
import { RunBudget } from '../src/agent/run-budget.ts';

/**
 * R10b, second round: the 25 adversary answers that were read as INVALID live (verbatim, 17 from f5db4f0 and 8 from 57f691f), in three encodings of the same content:
 *   F1 (17) `attacks` is a string with the array followed by a stray "}" (sometimes a newline)   F2 (3) `attacks` is a string holding {"attacks":[...]}   F3 (5) the root is wrapped under "argument".
 * They must read as VALID, with the attacks the model wrote and no more; anything the schema still refuses stays INVALID. All offline.
 */
const budget = () => new RunBudget({ maxQueriesPerRun: 5, readLimit: 50, maxTokensPerRun: 5_000_000, maxSteps: 3 });
const LIVE = JSON.parse(fs.readFileSync(new URL('./fixtures/model-review/r10b-adversary-invalid-live.json', import.meta.url), 'utf8')) as { count: number; items: { run: string; relationId: string; code: string; responseText: string }[] };
const receipt = { receiptId: 'r', provider: 'p', model: 'm', inputTokens: 1000, outputTokens: 238, totalTokens: 1238, latencyMs: 1, fromCache: false };
const toolCall = (text: string, transport: ReviewCall['transport']): ReviewCall => ({ status: 'PASS', responseText: text, receipt, transport });
const sides = (relationId: string) => relationId.split('__').map(side => { const [table, column] = side.split('.'); return { table: table!, column: column! }; }) as [{ table: string; column: string }, { table: string; column: string }];
const proposalOf = (relationId: string): ProbedProposalInput => {
  const [from, to] = sides(relationId);
  return { proposalId: relationId, from, to, coverageProbe: { status: 'EXECUTED', diagnostic: { coverage: { level: 'HIGH', matched: 5, probed: 5, threshold: 0.8 },
    multiplicity: { from: { rows: 5, distinctKeys: 5, maxRowsPerKey: 1 }, to: { rows: 5, distinctKeys: 5, maxRowsPerKey: 1 } },
    keyRules: { inclusion: { status: 'NO_VIOLATION_IN_SAMPLE', missingCount: 0 }, targetUniqueness: { status: 'NO_DUPLICATES_IN_SAMPLE' } } } } };
};
const none = (family: string) => ({ family, severity: 'none', recommend: 'keep', argument: '', evidenceRefs: [] });
const attacks = () => [none('HOMONYM'), { family: 'SIBLING', severity: 'minor', recommend: 'keep', argument: 'ws_ship_customer_sk is a role sibling', evidenceRefs: ['target.table', 'coverage'] }];
const ID = 'web_sales.ws_bill_customer_sk__customer.c_customer_sk';

/** Every judge accepts on the measured evidence alone, so the adversary is asked for each relation. */
async function review(relationId: string, responseText: string, transport: ReviewCall['transport'] = 'TOOL_CALL') {
  const packets = buildPackets([proposalOf(relationId)], { minDistinctKeys: 3, universeId: 'T' }).packets;
  const judge = (id: string) => new StandInModel(id, messages => toolCall(judgeAnswer('EVIDENCE_ONLY', JSON.parse(messages[1]!.content).packet), transport));
  const adversary = new StandInModel('adversary', () => toolCall(responseText, transport));
  const result = await runModelReview({ packets, judges: [judge('judge-a'), judge('judge-b')], adversary, budget: budget(), config: { minDistinctKeys: 3 } });
  return { result, review: result.reviews[0]!, adversary };
}
const strip = (text: string) => text.replace(/\\/g, '');

test('R10b live: all 25 adversary answers that were INVALID are VALID through the normalization, with the attacks the model wrote', async () => {
  assert.equal(LIVE.items.length, 25);
  assert.equal(LIVE.count, 25);
  const forms = new Map<string, number>();
  for (const item of LIVE.items) {
    const { review: reviewed, adversary, result } = await review(item.relationId, item.responseText);
    assert.equal(reviewed.adversary.status, 'COMPLETED', `${item.run} ${item.relationId}`);
    assert.equal(adversary.calls, 1, 'no retry');
    const model = reviewed.adversary.attacks.filter(attack => attack.source === 'MODEL');
    assert.deepEqual(model.map(attack => attack.family), ['HOMONYM', 'SIBLING'], item.relationId);
    // The attacks are the model's own words: what was parsed is found, verbatim, in the raw answer.
    const raw = strip(item.responseText);
    for (const attack of model) {
      assert.ok(raw.includes(`"family":"${attack.family}"`) && raw.includes(`"severity":"${attack.severity}"`) && raw.includes(`"recommend":"${attack.recommend}"`), item.relationId);
      assert.ok(attack.argument === '' || raw.includes(strip(attack.argument)), `${item.relationId}: the argument is the model's`);
      for (const ref of attack.evidenceRefs) assert.ok(raw.includes(`"${ref}"`), `${item.relationId}: ${ref}`);
    }
    const normalized = reviewed.adversary.call!.normalized!;
    assert.ok(normalized.length > 0, item.relationId);
    const adversaryRow = result.modelTable.find(entry => entry.role === 'adversary')!;
    assert.deepEqual([adversaryRow.normalizedCalls, adversaryRow.invalid], [1, 0]);
    const form = normalized.includes('root:argument-wrapper') ? 'F3' : normalized.includes('attacks:json-string+trailing-brace') ? 'F1' : normalized.includes('attacks:json-string+unwrapped') ? 'F2' : 'F0';
    forms.set(form, (forms.get(form) ?? 0) + 1);
    // Message text is never decoded: the same answers over a text transport stay INVALID, as before.
    assert.equal((await review(item.relationId, item.responseText, 'TEXT')).review.adversary.status, 'INVALID', item.relationId);
  }
  assert.deepEqual(Object.fromEntries([...forms].sort()), { F1: 17, F2: 3, F3: 5 });
});

test('F1: only trailing "}" and whitespace are dropped, once, and the array must then parse as an array', () => {
  const array = JSON.stringify(attacks());
  const wrap = (value: string) => JSON.stringify({ relationId: 'a', attacks: value });
  for (const tail of ['}', '}\n', '} ', '}}', '\n}\n']) {
    const out = normalizeToolArguments('ATTACK', wrap(array + tail));
    assert.deepEqual(out.normalized, ['attacks:json-string+trailing-brace'], JSON.stringify(tail));
    assert.deepEqual(JSON.parse(out.text), { relationId: 'a', attacks: attacks() });
  }
  for (const [name, value] of [['junk after the brace', array + '} x'], ['a bracket instead', array + ']'], ['garbage', 'not json}'], ['a cut array', array.slice(0, -2) + '}'], ['an object cut at its brace', '{"a":1}}'], ['a lone brace', '}'], ['text before the array', 'attacks: ' + array + '}']] as const) {
    assert.deepEqual(normalizeToolArguments('ATTACK', wrap(value)), { text: wrap(value), normalized: [] }, name);
  }
});

test('F2: a string holding an object whose only key is the field is unwrapped; any other object is refused', () => {
  const wrap = (value: unknown) => JSON.stringify({ relationId: 'a', attacks: JSON.stringify(value) });
  const out = normalizeToolArguments('ATTACK', wrap({ attacks: attacks() }));
  assert.deepEqual(out.normalized, ['attacks:json-string+unwrapped']);
  assert.deepEqual(JSON.parse(out.text), { relationId: 'a', attacks: attacks() });
  for (const [name, value] of [['another key as well', { attacks: attacks(), note: 'x' }], ['another name', { attack: attacks() }], ['the value is a string', { attacks: JSON.stringify(attacks()) }], ['the value is an object', { attacks: { HOMONYM: none('HOMONYM') } }], ['an empty object', {}], ['the family map', { HOMONYM: none('HOMONYM'), SIBLING: none('SIBLING') }]] as const) {
    const refused = normalizeToolArguments('ATTACK', wrap(value));
    assert.deepEqual(refused.normalized, [], name);
    assert.equal(parseAttacks(refused.text, 'a'), undefined, name);
  }
});

test('F3: a root wrapped under "argument" is unwrapped when it holds only the schema fields and the relation ids agree', () => {
  const content = { relationId: 'a', attacks: attacks() };
  const read = (root: unknown) => { const out = normalizeToolArguments('ATTACK', JSON.stringify(root)); return { ...out, parsed: parseAttacks(out.text, 'a') }; };
  const whole = read({ argument: content });
  assert.deepEqual(whole.normalized, ['root:argument-wrapper']);
  assert.equal(whole.parsed?.length, 2);
  const split = read({ relationId: 'a', argument: { attacks: attacks() } });
  assert.deepEqual(split.normalized, ['root:argument-wrapper']);
  assert.equal(split.parsed?.length, 2);
  assert.deepEqual(read({ relationId: 'a', argument: content }).normalized, ['root:argument-wrapper'], 'the same relation id at both levels');
  const inner = read({ argument: { relationId: 'a', attacks: JSON.stringify(attacks()) } });
  assert.deepEqual(inner.normalized, ['root:argument-wrapper', 'attacks:json-string'], 'a field inside the wrapper is decoded too');
  assert.equal(inner.parsed?.length, 2);
  for (const [name, root] of [
    ['a different relation id inside', { relationId: 'a', argument: { relationId: 'b', attacks: attacks() } }],
    ['a different attacks at both levels', { attacks: [none('HOMONYM')], argument: content }],
    ['an unrecognized key beside the wrapper', { argument: content, verdict: 'accept' }],
    ['an unrecognized key inside the wrapper', { argument: { ...content, verdict: 'accept' } }],
    ['the wrapper is a string', { argument: JSON.stringify(content) }],
    ['the wrapper is an array', { argument: [content] }],
    ['another wrapper name', { arguments: content }],
    ['a wrapper in a wrapper', { argument: { argument: content } }],
    ['the wrapper is empty', { argument: {} }]
  ] as const) {
    const refused = read(root);
    assert.equal(refused.parsed, undefined, name);
    assert.ok(!refused.normalized.includes('root:argument-wrapper'), `${name}: nothing is unwrapped`);
  }
  const evaluation = normalizeToolArguments('EVALUATION', JSON.stringify({ argument: { relationId: 'a', decision: 'defer', confidence: 'low', reasonCodes: ['NAME_AMBIGUOUS'], rationale: 'r' } }));
  assert.deepEqual(evaluation.normalized, ['root:argument-wrapper'], 'the judges get the same tolerance');
  assert.equal(parseEvaluation(evaluation.text, 'a')?.decision, 'defer');
});

test('through the review: an answer the schema still refuses after decoding is INVALID and defers; normalization never creates or raises anything', async () => {
  const refused = [
    JSON.stringify({ argument: { relationId: ID, attacks: attacks(), verdict: 'accept' } }),
    JSON.stringify({ relationId: ID, attacks: JSON.stringify({ attacks: attacks(), x: 1 }) }),
    JSON.stringify({ relationId: ID, attacks: JSON.stringify(attacks()) + '} tail' })
  ];
  for (const text of refused) {
    const { review: reviewed, adversary } = await review(ID, text);
    assert.equal(reviewed.adversary.status, 'INVALID', text.slice(0, 40));
    assert.equal(reviewed.decision, 'defer');
    assert.equal(adversary.calls, 1);
  }
  const blocking = [{ family: 'HOMONYM', severity: 'blocking', recommend: 'reject', argument: 'other entity', evidenceRefs: ['target.table'] }, none('SIBLING')];
  const { review: reviewed } = await review(ID, JSON.stringify({ argument: { relationId: ID, attacks: blocking } }));
  assert.equal(reviewed.decision, 'reject', 'a grounded blocking attack lowers the decision exactly as it would unwrapped');
  assert.deepEqual(reviewed.adversary.call?.normalized, ['root:argument-wrapper']);
});
