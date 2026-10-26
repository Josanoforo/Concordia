import test from 'node:test';
import assert from 'node:assert/strict';
import type { Nightshift } from '../src/clients/nightshift.ts';
import { reviewBlindCandidates } from '../src/agent/model-review/candidates.ts';
import { createCandidateReview } from '../src/agent/model-review/candidate-review.ts';
import { buildPackets, type ProbedProposalInput } from '../src/agent/model-review/evidence.ts';
import { NightshiftReviewModel } from '../src/agent/model-review/nightshift-model.ts';
import { adversaryMessages, judgeMessages, parseAttacks, parseEvaluation } from '../src/agent/model-review/prompts.ts';
import { estimateModelReviewCost, runModelReview } from '../src/agent/model-review/reviewer.ts';
import { attackAnswer, judgeAnswer, standInAdversary, standInJudge, StandInModel } from '../src/agent/model-review/standin.ts';
import { ATTACKS_TOOL_NAME, EVALUATION_TOOL_NAME, measureToolCost, toolFor, toolRequest, toolSchemaTokens } from '../src/agent/model-review/tool-schemas.ts';
import { LIVE_CALL_CALIBRATION, PLANNING_TOKENS_PER_CALL } from '../src/agent/model-review/calibration.ts';
import { ATTACK_FAMILIES, CONFIDENCES, DECISIONS, MODEL_ATTACK_FAMILIES, REASON_CODES, type ReviewCall, type ReviewTraceEvent } from '../src/agent/model-review/types.ts';
import { RunBudget } from '../src/agent/run-budget.ts';

/**
 * Round 10 correction C4 (progress events, the live token figure, the effective model per role) and E5-02 (the answers as a forced tool call). All offline: stand-ins and a scripted
 * Nightshift; no generation, no SQL.
 */
const budget = () => new RunBudget({ maxQueriesPerRun: 5, readLimit: 50, maxTokensPerRun: 5_000_000, maxSteps: 3 });
const defaults = { universeId: 'T', database: 'T_DB', normalization: 'text', normalizationVersion: 'text-exact-v1', normalizationAdapterCapability: 'exact-text' };
const RELATIONS = [['web_sales', 'ws_bill_customer_sk'], ['store_sales', 'ss_customer_sk'], ['catalog_sales', 'cs_bill_customer_sk'], ['web_returns', 'wr_returning_customer_sk']] as const;
const proposal = (table: string, column: string, over: { distinctKeys?: number; missing?: number } = {}): ProbedProposalInput => ({
  proposalId: `${table}.${column}__customer.c_customer_sk`, from: { table, column }, to: { table: 'customer', column: 'c_customer_sk' },
  coverageProbe: { status: 'EXECUTED', diagnostic: { coverage: { level: 'HIGH', matched: 5, probed: 5, threshold: 0.8 },
    multiplicity: { from: { rows: 5, distinctKeys: over.distinctKeys ?? 5, maxRowsPerKey: 1 }, to: { rows: 5, distinctKeys: 5, maxRowsPerKey: 1 } },
    keyRules: { inclusion: { status: over.missing ? 'VIOLATION_OBSERVED' : 'NO_VIOLATION_IN_SAMPLE', missingCount: over.missing ?? 0 }, targetUniqueness: { status: 'NO_DUPLICATES_IN_SAMPLE' } } } }
});
const proposals = (): ProbedProposalInput[] => [...RELATIONS.map(([table, column]) => proposal(table, column)), proposal('inventory', 'inv_item_sk', { missing: 1 })];
const packetsOf = (items = proposals()) => buildPackets(items, { minDistinctKeys: 3 }).packets;
const judgeModels = (count = 2) => Array.from({ length: count }, (_, index) => standInJudge(`judge-${String.fromCharCode(97 + index)}`, 'SEMANTIC'));
const run = (extra: Partial<Parameters<typeof runModelReview>[0]> = {}, config: Partial<Parameters<typeof runModelReview>[0]['config']> = {}) => {
  const events: ReviewTraceEvent[] = [];
  const promise = runModelReview({ packets: packetsOf(), judges: judgeModels(), adversary: standInAdversary('adversary'), budget: budget(), config: { minDistinctKeys: 3, ...config }, onEvent: event => events.push(event), ...extra });
  return promise.then(result => ({ result, events }));
};

test('C4a: the start event comes first, with the number of candidates, the cascade split and the bounds on calls and tokens', async () => {
  const { result, events } = await run({ unprobed: [{ relationId: 'x', source: { table: '', column: '' }, target: { table: '', column: '' }, reason: 'COVERAGE_NONE' }] }, { cascade: true });
  assert.equal(events[0]!.kind, 'model-review-start');
  const start = events[0]!.detail as any;
  assert.deepEqual({ candidates: start.candidates, relations: start.relations, notEvaluated: start.notEvaluated, floorRejected: start.floorRejected, evaluated: start.evaluated, judges: start.judges, cascade: start.cascade, transport: start.transport },
    { candidates: 6, relations: 5, notEvaluated: 1, floorRejected: 1, evaluated: 4, judges: 2, cascade: true, transport: 'TEXT' });
  // Four evaluated relations, all accept at the floor: with the cascade the minimum is judge A alone, the maximum is both judges and the adversary on each.
  assert.equal(start.attackEligible, 4);
  assert.deepEqual(start.calls, { minimum: 4, maximum: 12 });
  assert.equal(start.tokensPerCall, PLANNING_TOKENS_PER_CALL);
  assert.deepEqual({ minimum: start.projectedTokens.minimum, maximum: start.projectedTokens.maximum }, { minimum: 4 * PLANNING_TOKENS_PER_CALL, maximum: 12 * PLANNING_TOKENS_PER_CALL });
  assert.ok(start.projectedTokens.upperBound > start.projectedTokens.maximum, 'the gate keeps its conservative upper bound, above the live figure');
  assert.deepEqual(start.tokenBudget, { used: 0, limit: 5_000_000 });
  assert.deepEqual(result.start, start, 'the run keeps the start detail');
  // The real calls land inside the announced bounds.
  assert.ok(result.counts.calls >= start.calls.minimum && result.counts.calls <= start.calls.maximum);
});

test('C4a: a packet attack that already sustains takes the adversary out of the maximum', async () => {
  const items = [proposal('web_sales', 'ws_bill_customer_sk'), proposal('store_sales', 'ss_customer_sk', { distinctKeys: 1 })];
  const { events } = await run({ packets: packetsOf(items) });
  const start = events[0]!.detail as any;
  // distinctKeys 1 against a minimum of 3: the floor defers (evaluated, no attack eligibility).
  assert.deepEqual({ evaluated: start.evaluated, attackEligible: start.attackEligible, decidedByPacket: start.decidedByPacket }, { evaluated: 2, attackEligible: 1, decidedByPacket: 0 });
  assert.deepEqual(start.calls, { minimum: 4, maximum: 5 });
});

test('C4a: a progress event every N counted calls, between the start and the run events', async () => {
  const { result, events } = await run({}, { progressEveryCalls: 3 });
  const progress = events.filter(event => event.kind === 'model-review-progress');
  assert.equal(progress.length, Math.floor(result.counts.calls / 3));
  progress.forEach((event, index) => {
    const detail = event.detail as any;
    assert.equal(detail.callsMade, 3 * (index + 1));
    assert.ok(detail.relationsDone <= detail.relationsTotal && detail.relationsTotal === 5);
    assert.deepEqual(detail.callsExpected, (events[0]!.detail as any).calls);
    assert.ok(detail.tokens > 0 && detail.tokenBudget.used === detail.tokens, 'the run budget meter is read when it exists');
    assert.equal(typeof detail.elapsedMs, 'number');
  });
  assert.equal(events.at(-1)!.kind, 'model-review-run');
  assert.deepEqual(result.trace.map(event => event.kind).filter(kind => kind === 'model-review-start' || kind === 'model-review-progress').length, 1 + progress.length, 'the same events are in the run trace');
});

test('C4a: progressEveryCalls defaults to 25, 0 turns progress off, anything else is refused', async () => {
  assert.equal(((await run()).events[0]!.detail as any).progressEveryCalls, 25);
  const off = await run({}, { progressEveryCalls: 0 });
  assert.equal(off.events.filter(event => event.kind === 'model-review-progress').length, 0);
  assert.equal(off.events[0]!.kind, 'model-review-start', 'the start event is not optional');
  for (const bad of [-1, 1.5]) await assert.rejects(run({}, { progressEveryCalls: bad }), /MODEL_REVIEW_PROGRESS_EVERY_INVALID/);
});

test('C4a: the sink reaches the engine: createCandidateReview forwards options.onEvent, and request.onEvent when the engine supplies one', async () => {
  const seen: string[] = [], seenByRequest: string[] = [];
  const request = (onEvent?: (event: ReviewTraceEvent) => void) => ({ universeId: 'T', runId: 'r', executionMode: 'OFFLINE', dataOrigin: 'TEST', proposals: proposals(), tableColumns: {}, budget: budget(), now: () => '2026-10-25T00:00:00Z', ...(onEvent ? { onEvent } : {}) }) as any;
  const make = (onEvent?: (event: ReviewTraceEvent) => void) => createCandidateReview({ standIn: true, thresholds: { minDistinctKeys: 3 }, contractDefaults: defaults, ...(onEvent ? { onEvent } : {}) });
  await make(event => seen.push(event.kind))(request());
  assert.equal(seen[0], 'model-review-start');
  await make()(request(event => seenByRequest.push(event.kind)));
  assert.equal(seenByRequest[0], 'model-review-start');
});

test('C4b: the live per-call figure is recorded, the gate keeps its upper bound, and the cascade saving is valued at what the run measured', async () => {
  assert.equal(LIVE_CALL_CALIBRATION.totalTokensPerCall, Math.round(1_592_366 / 355));
  assert.equal(LIVE_CALL_CALIBRATION.inputTokensPerCall + LIVE_CALL_CALIBRATION.outputTokensPerCall, Math.round((986_768 + 101_520) / 242));
  assert.equal(PLANNING_TOKENS_PER_CALL, 4500);
  // Judge A always defers: with the cascade judge B and the adversary are skipped on every relation.
  const defer = new StandInModel('judge-a', messages => { const packet = JSON.parse(messages[1]!.content).packet; return JSON.stringify({ relationId: packet.relationId, decision: 'defer', confidence: 'medium', reasonCodes: ['NAME_AMBIGUOUS'], rationale: 'unclear' }); });
  const live = new StandInModel('judge-live', messages => JSON.stringify({ relationId: JSON.parse(messages[1]!.content).packet.relationId, decision: 'defer', confidence: 'low', reasonCodes: ['NAME_AMBIGUOUS'], rationale: 'unclear' }));
  const { result } = await run({ judges: [defer, live] }, { cascade: true });
  assert.equal(result.counts.skippedByCascade, 8, 'judge B and the adversary are skipped on each of the four evaluated relations');
  assert.ok(result.counts.cascadeEstimatedTokensAvoided > 0 && result.counts.cascadeTokensAvoidedObserved > 0);
  const judgeCalls = result.reviews.flatMap(review => review.evaluations).filter(item => item.status === 'VALID');
  const meanJudge = judgeCalls.reduce((sum, item) => sum + (item.tokens ?? 0), 0) / judgeCalls.length;
  // Four judge calls valued at the mean the run measured for judges; the four adversary calls had no live call of their stage, so they are valued at the planning figure.
  assert.equal(result.counts.cascadeTokensAvoidedObserved, Math.round(4 * meanJudge + 4 * PLANNING_TOKENS_PER_CALL));
});

test('C4b: with no live call at all, the saving is valued at the planning figure, below the gate estimate', async () => {
  const failing = new StandInModel('judge-a', () => ({ status: 'FAIL', error: { code: 'X' } }));
  const { result } = await run({ judges: [failing, standInJudge('judge-b', 'SEMANTIC')], packets: packetsOf([proposal('web_sales', 'ws_bill_customer_sk')]) }, { cascade: true });
  assert.equal(result.counts.skippedByCascade, 2, 'judge B and the adversary');
  assert.equal(result.counts.cascadeTokensAvoidedObserved, 2 * PLANNING_TOKENS_PER_CALL);
  assert.ok(result.counts.cascadeEstimatedTokensAvoided > result.counts.cascadeTokensAvoidedObserved, 'the gate estimate is the conservative upper bound');
});

const withModel = (model: StandInModel, name: (call: number) => string) => {
  let calls = 0;
  const original = model.complete.bind(model);
  model.complete = async (messages, options) => { const call: ReviewCall = await original(messages, options); if (call.receipt) call.receipt = { ...call.receipt, model: name(++calls) }; return call; };
  return model;
};

test('C4c: the effective model per role and the drift of the route are in the table, the run and the overlay; pinning is not active', async () => {
  // Every fifth call of a role is answered by another model, as the live route did.
  const judges = [withModel(standInJudge('judge-a', 'SEMANTIC'), n => (n % 4 === 0 ? 'claude-sonnet-4-5-20250929' : 'claude-sonnet-5')), withModel(standInJudge('judge-b', 'SEMANTIC'), () => 'claude-sonnet-5')];
  const adversary = withModel(standInAdversary('adversary'), n => (n === 1 ? 'claude-sonnet-4-6' : 'claude-sonnet-5'));
  const { overlay } = await reviewBlindCandidates({ proposals: proposals(), universeId: 'T', context: { minDistinctKeys: 3 }, judges, adversary, budget: budget(), config: { minDistinctKeys: 3 }, defaults, allowStandIn: true });
  const rows = Object.fromEntries(overlay.modelTable.map(row => [row.role, row]));
  assert.equal(rows['judge-a']!.effectiveModel, 'claude-sonnet-5');
  assert.deepEqual(rows['judge-a']!.drift, [{ model: 'claude-sonnet-4-5-20250929', calls: 1 }]);
  assert.deepEqual(rows['judge-b']!.drift, []);
  assert.deepEqual(rows['adversary']!.drift, [{ model: 'claude-sonnet-4-6', calls: 1 }]);
  const drift = overlay.modelDrift;
  assert.equal(drift.homogeneous, false);
  assert.equal(drift.pinned, false);
  assert.equal(drift.driftedCalls, 2);
  assert.equal(drift.receiptCalls, overlay.counts.calls);
  assert.deepEqual(drift.perRole.map(role => [role.role, role.effectiveModel, role.drifted.length]), [['judge-a', 'claude-sonnet-5', 1], ['judge-b', 'claude-sonnet-5', 0], ['adversary', 'claude-sonnet-5', 1]]);
  assert.match(overlay.limitations.join('\n'), /model drift inside the route: 2 of \d+ calls/);
});

test('C4c: a route that answered with one model is homogeneous and says nothing about drift', async () => {
  const { result } = await run();
  assert.equal(result.modelDrift.homogeneous, true);
  assert.equal(result.modelDrift.driftedCalls, 0);
  assert.ok(!result.limitations.some(line => line.includes('model drift')));
  assert.ok(result.modelTable.every(row => row.drift.length === 0 && (row.calls === 0 || row.effectiveModel === 'standin-offline')));
});

// ---------------------------------------------------------------- E5-02: tool-call transport
test('E5-02: the function schemas are closed and say what the strict parsers accept', () => {
  const evaluation = toolFor('EVALUATION').function.parameters as any, attacks = toolFor('ATTACK').function.parameters as any;
  assert.equal(toolFor('EVALUATION').function.name, EVALUATION_TOOL_NAME);
  assert.equal(toolFor('ATTACK').function.name, ATTACKS_TOOL_NAME);
  assert.equal(evaluation.additionalProperties, false);
  assert.deepEqual([...evaluation.required].sort(), ['confidence', 'decision', 'rationale', 'reasonCodes', 'relationId']);
  assert.deepEqual(evaluation.properties.decision.enum, [...DECISIONS]);
  assert.deepEqual(evaluation.properties.confidence.enum, [...CONFIDENCES]);
  assert.deepEqual(evaluation.properties.reasonCodes.items.enum, [...REASON_CODES]);
  assert.equal(attacks.additionalProperties, false);
  assert.equal(attacks.properties.attacks.minItems, MODEL_ATTACK_FAMILIES.length);
  assert.equal(attacks.properties.attacks.maxItems, MODEL_ATTACK_FAMILIES.length);
  assert.deepEqual(attacks.properties.attacks.items.properties.family.enum, [...MODEL_ATTACK_FAMILIES]);
  assert.ok(MODEL_ATTACK_FAMILIES.every(family => (ATTACK_FAMILIES as readonly string[]).includes(family)));
  assert.deepEqual(toolRequest('ATTACK').toolChoice, { type: 'function', function: { name: ATTACKS_TOOL_NAME } });
  assert.equal(toolRequest('EVALUATION').tools.length, 1);
  // What a model fills in from the schema is what the parsers read.
  const packet = packetsOf()[0]!;
  assert.ok(parseEvaluation(JSON.stringify({ relationId: packet.relationId, decision: 'accept', confidence: 'high', reasonCodes: ['NAME_ENTITY_MATCH'], rationale: 'ok' }), packet.relationId));
  assert.ok(parseAttacks(JSON.stringify({ relationId: packet.relationId, attacks: MODEL_ATTACK_FAMILIES.map(family => ({ family, severity: 'none', recommend: 'keep', argument: '', evidenceRefs: [] })) }), packet.relationId));
});

test('E5-02: what the schemas add to the input is measured offline, per stage, and added to the gate estimate', () => {
  const measured = measureToolCost();
  assert.deepEqual(measured.map(item => item.stage), ['EVALUATION', 'ATTACK']);
  for (const item of measured) {
    assert.ok(item.schemaChars > 200 && item.schemaTokensAtGateRatio > 100);
    assert.equal(item.gateAddsTokens, toolSchemaTokens(item.stage), 'the gate adds the 3a overhead of a small function plus the schema at the gate ratio');
    assert.ok(item.gateAddsTokens > item.smallFunctionMeasuredLive, 'never under the 3a measurement');
  }
  const packets = packetsOf(), config = { cascade: false as const };
  const text = estimateModelReviewCost(packets, 2, config), tool = estimateModelReviewCost(packets, 2, config, { transport: 'TOOL_CALL' });
  assert.equal(tool.calls, text.calls);
  const judgeCalls = text.evaluatedRelations * 2, attackCalls = text.calls - judgeCalls;
  assert.equal(tool.estimatedTokens - text.estimatedTokens, judgeCalls * toolSchemaTokens('EVALUATION') + attackCalls * toolSchemaTokens('ATTACK'));
});

type ChatOptions = { maxTokens: number; route?: string; tools?: object[]; toolChoice?: object; preserveTextOnFailure?: boolean };
/** A Nightshift whose chat answers like the stand-in panel, as tool-call arguments when it was asked for a tool. */
function scriptedNightshift(answer: (messages: { content: string }[], options: ChatOptions) => string, over: { text?: boolean } = {}) {
  const requests: { messages: { content: string }[]; options: ChatOptions }[] = [];
  const nightshift = { route: 'meterless/cheap', chat: async (messages: { content: string }[], options: ChatOptions) => {
    requests.push({ messages, options });
    const text = answer(messages, options), tool = (options.tools?.[0] as any)?.function?.name as string | undefined;
    return { text, receipt: { receiptId: `r${requests.length}`, provider: 'anthropic', model: 'claude-sonnet-5', inputTokens: 4000, outputTokens: 400, totalTokens: 4400, latencyMs: 1, fromCache: false }, policyAlerts: [], truncated: false, ...(tool && !over.text ? { toolCall: { name: tool } } : {}) };
  } } as unknown as Nightshift;
  return { nightshift, requests };
}
const panelAnswer = (messages: { content: string }[]) => {
  const packet = JSON.parse(messages[1]!.content).packet;
  return /adversarial reviewer/.test(messages[0]!.content) ? attackAnswer(packet) : judgeAnswer('SEMANTIC', packet);
};

test('E5-02: by default nothing but the messages is sent; with TOOL_CALL the stage names the forced function', async () => {
  const { nightshift, requests } = scriptedNightshift(panelAnswer);
  const packet = packetsOf()[0]!;
  const plain = new NightshiftReviewModel('judge-a', nightshift), tool = new NightshiftReviewModel('judge-a', nightshift, { structuredOutput: 'TOOL_CALL' });
  assert.equal(plain.transport, 'TEXT');
  assert.equal(tool.transport, 'TOOL_CALL');
  const messages = judgeMessages(packet, 'A');
  assert.equal(plain.estimateTokens(messages, 1500, 'EVALUATION'), plain.estimateTokens(messages, 1500));
  assert.equal(tool.estimateTokens(messages, 1500, 'EVALUATION'), plain.estimateTokens(messages, 1500) + toolSchemaTokens('EVALUATION'));
  assert.equal(tool.estimateTokens(messages, 1500), plain.estimateTokens(messages, 1500), 'without a stage no tool is sent, so nothing is added');

  const plainCall = await plain.complete(messages, { maxOutputTokens: 1500, stage: 'EVALUATION' });
  assert.equal(requests[0]!.options.tools, undefined);
  assert.equal(requests[0]!.options.toolChoice, undefined);
  assert.equal(plainCall.transport, 'TEXT');

  const evalCall = await tool.complete(messages, { maxOutputTokens: 1500, stage: 'EVALUATION' });
  assert.equal((requests[1]!.options.tools![0] as any).function.name, EVALUATION_TOOL_NAME);
  assert.deepEqual(requests[1]!.options.toolChoice, { type: 'function', function: { name: EVALUATION_TOOL_NAME } });
  assert.equal(evalCall.transport, 'TOOL_CALL');
  assert.ok(parseEvaluation(evalCall.responseText!, packet.relationId), 'the arguments of the call are the JSON the parsers read');

  await tool.complete(adversaryMessages(packet, []), { maxOutputTokens: 3000, stage: 'ATTACK' });
  assert.equal((requests[2]!.options.tools![0] as any).function.name, ATTACKS_TOOL_NAME);
});

test('E5-02: a forced tool call that still comes back as text is read as text and recorded as such', async () => {
  const { nightshift } = scriptedNightshift(panelAnswer, { text: true });
  const model = new NightshiftReviewModel('judge-a', nightshift, { structuredOutput: 'TOOL_CALL' });
  const call = await model.complete(judgeMessages(packetsOf()[0]!, 'A'), { maxOutputTokens: 1500, stage: 'EVALUATION' });
  assert.equal(call.status, 'PASS');
  assert.equal(call.transport, 'TEXT');
});

test('E5-02: end to end over the tool-call transport: same decisions, the transport in the start event, the trace and the call records, and the schema in the gate estimate', async () => {
  const text = scriptedNightshift(panelAnswer), tool = scriptedNightshift(panelAnswer);
  const review = (nightshift: Nightshift, structuredOutput?: 'TOOL_CALL') => {
    const events: ReviewTraceEvent[] = [];
    return reviewBlindCandidates({ proposals: proposals(), universeId: 'T', context: { minDistinctKeys: 3 }, budget: budget(), config: { minDistinctKeys: 3 }, defaults,
      judges: ['judge-a', 'judge-b'].map(id => new NightshiftReviewModel(id, nightshift, structuredOutput ? { structuredOutput } : {})), adversary: new NightshiftReviewModel('adversary', nightshift, structuredOutput ? { structuredOutput } : {}), onEvent: event => events.push(event) }).then(result => ({ ...result, events }));
  };
  const plain = await review(text.nightshift), forced = await review(tool.nightshift, 'TOOL_CALL');
  assert.deepEqual(forced.run.reviews.map(item => [item.relationId, item.decision]), plain.run.reviews.map(item => [item.relationId, item.decision]));
  assert.equal(plain.run.start.transport, 'TEXT');
  assert.equal(forced.run.start.transport, 'TOOL_CALL');
  assert.ok(forced.run.start.projectedTokens.upperBound > plain.run.start.projectedTokens.upperBound);
  assert.ok(tool.requests.every(request => request.options.tools?.length === 1 && request.options.toolChoice));
  assert.ok(text.requests.every(request => request.options.tools === undefined));
  const calls = forced.events.filter(event => event.kind === 'model-review-call');
  assert.ok(calls.length > 0 && calls.every(event => event.transport === 'TOOL_CALL'));
  assert.ok(forced.run.reviews.flatMap(item => item.evaluations).every(item => item.call?.transport === 'TOOL_CALL'));
  assert.ok(forced.run.reviews.some(item => item.adversary.call?.transport === 'TOOL_CALL'));
  assert.ok(plain.events.filter(event => event.kind === 'model-review-call').every(event => event.transport === 'TEXT'));
});

test('E5-02: createCandidateReview asks its judges through the forced tool call by default and its adversary in plain text (R10b); each role opts in or out on its own', async () => {
  const { nightshift, requests } = scriptedNightshift(panelAnswer);
  const request = { universeId: 'T', runId: 'r', executionMode: 'OFFLINE', dataOrigin: 'TEST', proposals: proposals(), tableColumns: {}, budget: budget(), now: () => '2026-10-25T00:00:00Z' } as any;
  await createCandidateReview({ model: nightshift, thresholds: { minDistinctKeys: 3 }, contractDefaults: defaults })(request);
  const isAdversary = (item: { messages: { content: string }[] }) => /adversarial reviewer/.test(item.messages[0]!.content);
  const forced = (item: { options: { tools?: object[]; toolChoice?: object } }) => item.options.tools?.length === 1 && Boolean(item.options.toolChoice);
  assert.ok(requests.some(isAdversary) && requests.some(item => !isAdversary(item)));
  assert.ok(requests.filter(item => !isAdversary(item)).every(forced), 'the judges go through the forced tool call by default');
  assert.ok(requests.filter(isAdversary).every(item => item.options.tools === undefined && item.options.toolChoice === undefined), 'the adversary answers in plain text by default: its nested array was returned in wrong encodings over the tool call (R10b)');
  let before = requests.length;
  await createCandidateReview({ model: nightshift, thresholds: { minDistinctKeys: 3 }, contractDefaults: defaults, structuredOutput: 'NONE' })({ ...request, budget: budget() });
  assert.ok(requests.length > before && requests.slice(before).every(item => item.options.tools === undefined), "'NONE' asks the judges for plain text, and the adversary is text already");
  before = requests.length;
  await createCandidateReview({ model: nightshift, thresholds: { minDistinctKeys: 3 }, contractDefaults: defaults, adversaryStructuredOutput: 'TOOL_CALL' })({ ...request, budget: budget() });
  assert.ok(requests.slice(before).some(isAdversary) && requests.slice(before).every(forced), "the adversary can still be opted into the tool call");
});

test('E5-02: an unparsable tool-call answer stays INVALID: no retry, the call is counted and traced, and nothing is approved', async () => {
  const { nightshift, requests } = scriptedNightshift(() => '{"relationId":"x","decision":"accept"');
  const events: ReviewTraceEvent[] = [];
  const result = await reviewBlindCandidates({ proposals: [proposal('web_sales', 'ws_bill_customer_sk')], universeId: 'T', context: { minDistinctKeys: 3 }, budget: budget(), config: { minDistinctKeys: 3 }, defaults,
    judges: [new NightshiftReviewModel('judge-a', nightshift, { structuredOutput: 'TOOL_CALL' }), new NightshiftReviewModel('judge-b', nightshift, { structuredOutput: 'TOOL_CALL' })], adversary: new NightshiftReviewModel('adversary', nightshift, { structuredOutput: 'TOOL_CALL' }), onEvent: event => events.push(event) });
  assert.equal(requests.length, 2, 'one call per judge, no repair retry');
  assert.deepEqual(result.run.reviews[0]!.evaluations.map(item => item.status), ['INVALID', 'INVALID']);
  assert.equal(result.contracts.length, 0);
  assert.equal(events.filter(event => event.kind === 'model-review-parse' && event.parseStatus === 'INVALID').length, 2);
  assert.equal(result.run.counts.tokens, 2 * 4400, 'the invalid answers are charged');
});
