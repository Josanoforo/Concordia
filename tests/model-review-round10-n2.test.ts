import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createReviewDecisionMemory, readReviewDecisionLedger } from '../src/agent/review-decision-memory.ts';
import { ROOT } from '../src/runtime.ts';
import type { Nightshift } from '../src/clients/nightshift.ts';
import { reviewBlindCandidates } from '../src/agent/model-review/candidates.ts';
import { createCandidateReview } from '../src/agent/model-review/candidate-review.ts';
import { canonicalJson, checkClaim, evidenceFingerprint, reusedDecision, worthRecording } from '../src/agent/model-review/decision-memory.ts';
import { buildPackets, type ProbedProposalInput } from '../src/agent/model-review/evidence.ts';
import { NightshiftReviewModel } from '../src/agent/model-review/nightshift-model.ts';
import { runModelReview } from '../src/agent/model-review/reviewer.ts';
import { attackAnswer, judgeAnswer, standInAdversary, standInJudge } from '../src/agent/model-review/standin.ts';
import { MODEL_REVIEW_PROMPT_VERSION, MODEL_REVIEWED, REASON_CODES, REUSED_REVIEW_DECISION_REASON, type ReviewDecisionClaim, type ReviewDecisionMemory, type ReviewDecisionRecord, type ReviewTraceEvent } from '../src/agent/model-review/types.ts';
import { RunBudget } from '../src/agent/run-budget.ts';

/**
 * Round 10 N2: negative memory of the review. A rejection or deferral already taken on the same evidence (fingerprint) and prompt version is not asked of the models again.
 * All offline: a scripted Nightshift (kind LIVE_MODEL, so the decisions are recordable) and a fake `reviewDecisionMemory`; no generation, no SQL.
 */
const budget = () => new RunBudget({ maxQueriesPerRun: 5, readLimit: 50, maxTokensPerRun: 5_000_000, maxSteps: 3 });
const defaults = { universeId: 'T', database: 'T_DB', normalization: 'text', normalizationVersion: 'text-exact-v1', normalizationAdapterCapability: 'exact-text' };
const proposal = (table: string, column: string, over: { distinctKeys?: number; missing?: number } = {}): ProbedProposalInput => ({
  proposalId: `${table}.${column}__customer.c_customer_sk`, from: { table, column }, to: { table: 'customer', column: 'c_customer_sk' },
  coverageProbe: { status: 'EXECUTED', diagnostic: { coverage: { level: 'HIGH', matched: 5, probed: 5, threshold: 0.8 },
    multiplicity: { from: { rows: 5, distinctKeys: over.distinctKeys ?? 5, maxRowsPerKey: 1 }, to: { rows: 5, distinctKeys: 5, maxRowsPerKey: 1 } },
    keyRules: { inclusion: { status: over.missing ? 'VIOLATION_OBSERVED' : 'NO_VIOLATION_IN_SAMPLE', missingCount: over.missing ?? 0 }, targetUniqueness: { status: 'NO_DUPLICATES_IN_SAMPLE' } } } }
});
const A1 = 'web_sales.ws_bill_customer_sk__customer.c_customer_sk', A2 = 'store_sales.ss_customer_sk__customer.c_customer_sk';
const R1 = 'store_sales.ss_item_sk__customer.c_customer_sk', D1 = 'catalog_sales.cs_bill_customer_sk__customer.c_customer_sk', F1 = 'inventory.inv_item_sk__customer.c_customer_sk';
/** Two approvals, one rejection by name, one deferral by too few keys, one rejection the evidence floor decides alone (no model, never looked up). */
const proposals = (): ProbedProposalInput[] => [proposal('web_sales', 'ws_bill_customer_sk'), proposal('store_sales', 'ss_customer_sk'), proposal('store_sales', 'ss_item_sk'), proposal('catalog_sales', 'cs_bill_customer_sk', { distinctKeys: 1 }), proposal('inventory', 'inv_item_sk', { missing: 1 })];
const packetsOf = (items = proposals()) => buildPackets(items, { minDistinctKeys: 3, universeId: 'T' }).packets;

type ChatOptions = { maxTokens: number; route?: string; tools?: object[]; toolChoice?: object; preserveTextOnFailure?: boolean };
const panelAnswer = (messages: { content: string }[]) => {
  const packet = JSON.parse(messages[1]!.content).packet;
  return /adversarial reviewer/.test(messages[0]!.content) ? attackAnswer(packet) : judgeAnswer('SEMANTIC', packet);
};
/** A Nightshift whose chat answers like the stand-in panel; `model` lets a test make the route answer with another model. */
function scriptedNightshift(answer: (messages: { content: string }[], options: ChatOptions) => string = panelAnswer, model = 'claude-sonnet-5') {
  const requests: { messages: { content: string }[]; options: ChatOptions }[] = [];
  const nightshift = { route: 'meterless/cheap', chat: async (messages: { content: string }[], options: ChatOptions) => {
    requests.push({ messages, options });
    const text = answer(messages, options), tool = (options.tools?.[0] as any)?.function?.name as string | undefined;
    return { text, receipt: { receiptId: `r${requests.length}`, provider: 'anthropic', model, inputTokens: 4000, outputTokens: 400, totalTokens: 4400, latencyMs: 1, fromCache: false }, policyAlerts: [], truncated: false, ...(tool ? { toolCall: { name: tool } } : {}) };
  } } as unknown as Nightshift;
  return { nightshift, requests };
}
const asked = (requests: { messages: { content: string }[] }[]) => requests.map(request => JSON.parse(request.messages[1]!.content).packet.relationId as string);
const liveModels = (nightshift: Nightshift, structuredOutput?: 'TOOL_CALL') => ({
  judges: ['judge-a', 'judge-b'].map(id => new NightshiftReviewModel(id, nightshift, structuredOutput ? { structuredOutput } : {})), adversary: new NightshiftReviewModel('adversary', nightshift, structuredOutput ? { structuredOutput } : {})
});

/** The memory X5 implements, reduced to a Map keyed by relation, fingerprint and prompt version. `claims` can be seeded or filled by `record`. */
function fakeMemory(seed: Record<string, ReviewDecisionClaim> = {}) {
  const claims = new Map(Object.entries(seed)), lookups: [string, string, string][] = [], recorded: ReviewDecisionRecord[] = [];
  const key = (id: string, fingerprint: string, version: string) => `${id}|${fingerprint}|${version}`;
  const memory: ReviewDecisionMemory = {
    lookup: (id, fingerprint, version) => { lookups.push([id, fingerprint, version]); return claims.get(key(id, fingerprint, version)) ?? claims.get(id) ?? null; },
    record: decisions => { recorded.push(...decisions); for (const item of decisions) claims.set(key(item.relationId, item.evidenceFingerprint, item.promptVersion), { decision: item.decision, evidenceFingerprint: item.evidenceFingerprint, promptVersion: item.promptVersion, reasons: item.reasons, confidence: item.confidence, origin: item.origin, provenance: item.provenance, calls: item.calls, tokens: item.tokens, recordedRunId: 'pass-1' }); }
  };
  return { memory, claims, lookups, recorded };
}
const review = (memory: ReviewDecisionMemory | undefined, nightshift: Nightshift, over: { cascade?: boolean; structuredOutput?: 'TOOL_CALL'; items?: ProbedProposalInput[] } = {}) => {
  const events: ReviewTraceEvent[] = [];
  return reviewBlindCandidates({ proposals: over.items ?? proposals(), universeId: 'T', context: { minDistinctKeys: 3 }, budget: budget(), config: { minDistinctKeys: 3, ...(over.cascade ? { cascade: true } : {}) }, defaults,
    ...liveModels(nightshift, over.structuredOutput), onEvent: event => events.push(event), ...(memory ? { reviewDecisionMemory: memory } : {}) }).then(result => ({ ...result, events }));
};

test('N2 fingerprint: the same evidence hashes alike whatever the key order, a different one does not, and run identifiers are left out', () => {
  const [first, second] = [packetsOf()[2]!, packetsOf()[2]!];
  assert.match(evidenceFingerprint(first), /^[0-9a-f]{64}$/);
  assert.equal(evidenceFingerprint(first), evidenceFingerprint(second), 'same input, same hash');
  const reordered = JSON.parse(JSON.stringify(first)), keys = Object.keys(reordered).reverse();
  assert.equal(evidenceFingerprint(Object.fromEntries(keys.map(key => [key, reordered[key]])) as any), evidenceFingerprint(first), 'object key order does not matter');
  assert.equal(canonicalJson({ b: 1, a: { d: undefined, c: 2 } }), '{"a":{"c":2},"b":1}');
  // Run identifiers and moments never take part, at any depth.
  const noisy = { ...first, runId: 'r-1', requestId: 'q', generatedAt: '2026-10-25T00:00:00Z', coverage: { ...first.coverage, timestamp: 'x' } } as any;
  assert.equal(evidenceFingerprint({ ...noisy, runId: 'r-2', generatedAt: '2026-10-26T00:00:00Z' }), evidenceFingerprint(noisy));
  assert.equal(evidenceFingerprint(noisy), evidenceFingerprint(first), 'a run id or a timestamp, at any depth, is not evidence');
  // Anything the prompt shows changes it: counts, siblings, the tie-break.
  const other = packetsOf([proposal('store_sales', 'ss_item_sk', { distinctKeys: 4 })])[0]!;
  assert.notEqual(evidenceFingerprint(other), evidenceFingerprint(first));
  assert.notEqual(evidenceFingerprint({ ...first, coverage: { ...first.coverage, matched: first.coverage.matched - 1 } }), evidenceFingerprint(first));
  assert.notEqual(evidenceFingerprint({ ...first, tieBreak: { decisive: true, winner: 'THIS', reason: 'DECIDED_BY_NAME_VS_TABLE', mode: 'compact' } }), evidenceFingerprint(first));
  assert.notEqual(evidenceFingerprint(packetsOf(proposals().slice(2))[0]!), evidenceFingerprint(first), 'a different sibling set is different evidence');
  assert.equal(new Set(packetsOf().map(evidenceFingerprint)).size, 5);
});

test('N2: pass 1 records its rejections and deferrals (not approvals, not the floor, not stand-ins); pass 2 reuses them with 0 calls and reviews the rest', async () => {
  const store = fakeMemory(), pass1 = scriptedNightshift();
  const first = await review(store.memory, pass1.nightshift);
  assert.deepEqual(first.run.reviews.map(item => [item.relationId, item.decision]), [[A1, 'accept'], [A2, 'accept'], [R1, 'reject'], [D1, 'defer'], [F1, 'reject']]);
  assert.equal(pass1.requests.length, 10, 'A1 and A2: two judges and the adversary; R1 and D1: two judges; F1: the floor alone');
  assert.deepEqual(store.lookups.map(item => item[0]).sort(), [A1, A2, D1, R1].sort(), 'the floor rejection is not looked up: it needs no model');
  assert.deepEqual(store.recorded.map(item => [item.relationId, item.decision]).sort(), [[D1, 'defer'], [R1, 'reject']].sort(), 'only the new rejections and deferrals');
  const record = store.recorded.find(item => item.relationId === R1)!;
  assert.deepEqual({ origin: record.origin, provenance: record.provenance, promptVersion: record.promptVersion, models: record.models, requested: record.requestedModels, calls: record.calls, tokens: record.tokens, judges: record.config.judges },
    { origin: MODEL_REVIEWED, provenance: 'LIVE_MODEL', promptVersion: MODEL_REVIEW_PROMPT_VERSION, models: ['claude-sonnet-5'], requested: ['meterless/cheap'], calls: 2, tokens: 8800, judges: 2 });
  assert.match(record.evidenceFingerprint, /^[0-9a-f]{64}$/);
  assert.ok(record.reasons.includes('NAME_ENTITY_MISMATCH'));
  assert.equal(first.run.decisionMemory!.recorded, 2);
  assert.equal(first.overlay.counts.reusedNegative, 0, 'a memory was supplied and held nothing');

  const pass2 = scriptedNightshift();
  const second = await review(store.memory, pass2.nightshift);
  assert.deepEqual(asked(pass2.requests).filter(id => id === R1 || id === D1), [], 'a hit costs 0 calls');
  assert.equal(pass2.requests.length, 6, 'only the approvals are asked again');
  assert.deepEqual(second.run.reusedDecisions!.map(item => [item.relationId, item.decision, item.reasonCode, item.origin, item.calls, item.tokens]).sort(),
    [[D1, 'defer', REUSED_REVIEW_DECISION_REASON, MODEL_REVIEWED, 0, 0], [R1, 'reject', REUSED_REVIEW_DECISION_REASON, MODEL_REVIEWED, 0, 0]]);
  assert.equal(second.run.counts.calls, 6);
  assert.equal(second.run.counts.tokens, 6 * 4400);
  assert.deepEqual(second.run.reviews.map(item => [item.relationId, item.decision]), [[A1, 'accept'], [A2, 'accept'], [F1, 'reject']], 'the reviews hold only what a model (or the floor) decided now');
  assert.equal(second.contracts.length, 2, 'the approvals still come from fresh reviews');
  assert.deepEqual(store.recorded.length, 2, 'nothing new to record the second time');
});

test('N2 overlay: reusedNegative list and counts, the saving in calls and tokens, and the reused ones stay out of the contracts like any rejection or deferral', async () => {
  const store = fakeMemory();
  const baseline = await review(store.memory, scriptedNightshift().nightshift);
  const pass2 = await review(store.memory, scriptedNightshift().nightshift);
  const { overlay } = pass2;
  assert.deepEqual(overlay.reusedNegative!.map(item => [item.relationId, item.decision]).sort(), [[D1, 'defer'], [R1, 'reject']]);
  assert.deepEqual(overlay.counts.reusedNegative, 2);
  assert.equal(overlay.counts.reusedNegativeCallsAvoided, 4, 'the calls the first review made for them');
  assert.equal(overlay.counts.reusedNegativeTokensAvoided, 4 * 4400, 'their own recorded cost');
  assert.equal(baseline.overlay.counts.calls - overlay.counts.calls, overlay.counts.reusedNegativeCallsAvoided, 'calls reflect the saving');
  assert.equal(baseline.overlay.counts.tokens - overlay.counts.tokens, overlay.counts.reusedNegativeTokensAvoided, 'tokens reflect the saving');
  assert.equal(overlay.counts.candidates, overlay.counts.reviewed + overlay.counts.reusedNegative! + overlay.counts.reused + overlay.counts.notReviewed, 'every candidate is accounted for');
  const reused = overlay.notApproved.filter(item => item.reasons[0] === REUSED_REVIEW_DECISION_REASON);
  assert.deepEqual(reused.map(item => [item.relationId, item.decision, item.reviewed]).sort(), [[D1, 'defer', false], [R1, 'reject', false]]);
  assert.ok(reused.find(item => item.relationId === R1)!.reasons.includes('NAME_ENTITY_MISMATCH'), 'the original reasons travel with the reuse');
  assert.ok(overlay.deferred.some(item => item.id === R1 && item.reason.startsWith('reject: REUSED_REVIEW_DECISION_FROM_MEMORY')));
  assert.ok(!overlay.relations.some(item => item.id === R1 || item.id === D1) && !pass2.contracts.some(item => item.id === R1 || item.id === D1), 'no contract');
  assert.ok(overlay.reusedNegative!.every(item => item.origin === MODEL_REVIEWED && item.promptVersion === MODEL_REVIEW_PROMPT_VERSION && /^[0-9a-f]{64}$/.test(item.evidenceFingerprint) && item.recordedRunId === 'pass-1'));
  assert.ok(overlay.limitations.some(line => /review decision memory: 2 rejection\/deferral decision\(s\) reused/.test(line) && /never reused from the memory/.test(line)));
  assert.deepEqual({ lookups: overlay.decisionMemory!.lookups, hits: overlay.decisionMemory!.hits, ignored: overlay.decisionMemory!.ignoredClaims }, { lookups: 4, hits: 2, ignored: 0 });
});

test('N2 trace: the start event counts the reuse, each reused decision is traced with 0 calls, and the progress and run events carry it', async () => {
  const store = fakeMemory();
  await review(store.memory, scriptedNightshift().nightshift);
  const { events, run } = await review(store.memory, scriptedNightshift().nightshift);
  const start = events[0]!.detail as any;
  assert.equal(events[0]!.kind, 'model-review-start');
  assert.deepEqual({ candidates: start.candidates, relations: start.relations, reusedNegative: start.reusedNegative, evaluated: start.evaluated }, { candidates: 5, relations: 3, reusedNegative: 2, evaluated: 2 });
  assert.deepEqual(start.calls, { minimum: 4, maximum: 6 }, 'the bounds cover only what is still to be asked');
  const decisions = events.filter(event => event.kind === 'model-review-decision' && (event.detail as any).reused === true);
  assert.deepEqual(decisions.map(event => event.relationId).sort(), [D1, R1]);
  for (const event of decisions) assert.deepEqual({ ...(event.detail as any) }, { ...(event.detail as any), calls: 0, tokens: 0, origin: MODEL_REVIEWED, reasons: [REUSED_REVIEW_DECISION_REASON] });
  assert.ok(events.indexOf(decisions[0]!) > 0, 'after the start event');
  assert.equal(events.filter(event => event.kind === 'model-review-call' && (event.relationId === R1 || event.relationId === D1)).length, 0);
  assert.equal((events.at(-1)!.detail as any).decisionMemory.hits, 2);
  assert.equal(run.trace.filter(event => event.kind === 'model-review-decision').length, 5, 'reused decisions are in the run trace too');
});

test('N2: a different fingerprint is reviewed again', async () => {
  const store = fakeMemory();
  await review(store.memory, scriptedNightshift().nightshift);
  // R1 now has other evidence (a different key count): its old rejection says nothing about it.
  const items = proposals().map(item => item.proposalId === R1 ? proposal('store_sales', 'ss_item_sk', { distinctKeys: 4 }) : item);
  const second = scriptedNightshift();
  const result = await review(store.memory, second.nightshift, { items });
  assert.ok(asked(second.requests).includes(R1), 'asked again');
  assert.ok(!result.run.reusedDecisions!.some(item => item.relationId === R1));
  assert.ok(store.lookups.some(([id, fingerprint]) => id === R1 && fingerprint === evidenceFingerprint(packetsOf(items).find(packet => packet.relationId === R1)!)));
});

test('N2: a claim recorded under another prompt version, or kept by a lookup that ignores the version, is reviewed again', async () => {
  const store = fakeMemory();
  await review(store.memory, scriptedNightshift().nightshift);
  const stale: Record<string, ReviewDecisionClaim> = {};
  for (const [key, claim] of store.claims) stale[key.split('|')[0]!] = { ...claim, promptVersion: 'model-review-prompts-v3' };
  const old = fakeMemory(stale), second = scriptedNightshift();
  const result = await review(old.memory, second.nightshift);
  assert.equal(second.requests.length, 10, 'everything is asked again');
  assert.equal(result.run.reusedDecisions!.length, 0);
  assert.equal(result.run.decisionMemory!.ignoredClaims, 2, 'the lookup answered, the reviewer refused the claim');
  assert.ok(old.lookups.every(item => item[2] === MODEL_REVIEW_PROMPT_VERSION), 'the lookup is asked with the current prompt version');
});

test('N2: it never reuses towards an approval: an accept claim, or a claim of anything but a rejection or deferral, is ignored', async () => {
  const [a1, r1] = [packetsOf().find(packet => packet.relationId === A1)!, packetsOf().find(packet => packet.relationId === R1)!];
  const claim = (packet: typeof a1, decision: string): ReviewDecisionClaim => ({ decision: decision as any, evidenceFingerprint: evidenceFingerprint(packet), promptVersion: MODEL_REVIEW_PROMPT_VERSION, reasons: ['NAME_ENTITY_MATCH'], origin: MODEL_REVIEWED, provenance: 'LIVE_MODEL' });
  const store = fakeMemory({ [A1]: claim(a1, 'accept'), [R1]: claim(r1, 'accept'), [A2]: claim(packetsOf().find(packet => packet.relationId === A2)!, 'approved') });
  const second = scriptedNightshift();
  const result = await review(store.memory, second.nightshift);
  assert.equal(result.run.reusedDecisions!.length, 0, 'nothing is reused');
  assert.equal(second.requests.length, 10, 'every relation is reviewed');
  assert.equal(result.run.reviews.find(item => item.relationId === R1)!.decision, 'reject', 'the decision is the model\'s, not the claim\'s');
  assert.ok(store.recorded.every(item => item.decision === 'reject' || item.decision === 'defer'), 'an approval is never handed to the memory');
  assert.equal(checkClaim({ ...claim(a1, 'accept') }, evidenceFingerprint(a1)).reuse, false);
  assert.equal(checkClaim({ ...claim(a1, 'reject'), origin: 'HUMAN_REVIEWED' as any }, evidenceFingerprint(a1)).reuse, false);
  assert.equal(checkClaim({ ...claim(a1, 'reject'), provenance: 'STAND_IN_OFFLINE' }, evidenceFingerprint(a1)).reuse, false, 'a stand-in\'s decision is no memory');
  assert.deepEqual(checkClaim({ ...claim(a1, 'defer') }, evidenceFingerprint(a1)), { reuse: true, decision: 'defer' });
  assert.equal(checkClaim(null, 'x').reuse, false);
});

test('N2: without the dependency the review is unchanged, and an empty memory changes nothing but the extra fields', async () => {
  const plain = await review(undefined, scriptedNightshift().nightshift);
  assert.equal(plain.run.reusedDecisions, undefined);
  assert.equal(plain.run.decisionMemory, undefined);
  assert.equal(plain.overlay.reusedNegative, undefined);
  assert.equal(plain.overlay.decisionMemory, undefined);
  assert.equal(plain.overlay.counts.reusedNegative, undefined);
  assert.equal((plain.events[0]!.detail as any).reusedNegative, undefined);
  assert.equal(plain.events.some(event => (event.detail as any)?.reused === true), false);
  assert.equal(plain.overlay.notApproved.some(item => item.reasons.includes(REUSED_REVIEW_DECISION_REASON)), false);
  const empty = await review(fakeMemory().memory, scriptedNightshift().nightshift);
  const shape = (result: typeof plain) => ({ decisions: result.run.reviews.map(item => [item.relationId, item.decision, item.reasons, item.calls, item.tokens]), counts: { ...result.run.counts, reusedNegative: undefined, reusedNegativeCallsAvoided: undefined, reusedNegativeTokensAvoided: undefined }, contracts: result.contracts.map(item => item.id), notApproved: result.overlay.notApproved });
  assert.deepEqual(shape(empty), shape(plain));
  // No memory at all, at the engine seam too: the request carries none.
  const request = { universeId: 'T', runId: 'r', executionMode: 'OFFLINE', dataOrigin: 'TEST', proposals: proposals(), tableColumns: {}, budget: budget(), now: () => '2026-10-25T00:00:00Z' } as any;
  const outcome = await createCandidateReview({ model: scriptedNightshift().nightshift, thresholds: { minDistinctKeys: 3 }, contractDefaults: defaults })(request);
  assert.equal((outcome.overlay as any).reusedNegative, undefined);
});

test('N2: the cascade stays as it was: reused relations leave the cascade out, and the rest skips exactly what it skipped', async () => {
  const store = fakeMemory(), pass1 = scriptedNightshift();
  const first = await review(store.memory, pass1.nightshift, { cascade: true });
  assert.equal(first.run.counts.skippedByCascade, 3, 'judge B on R1 and on D1, and the adversary on R1 (its floor allows an accept)');
  assert.equal(first.run.counts.calls, 1 + 1 + 3 + 3 - 0, 'A1 and A2: judge A, judge B and the adversary; R1 and D1: judge A alone');
  const pass2 = scriptedNightshift();
  const second = await review(store.memory, pass2.nightshift, { cascade: true });
  assert.equal(second.run.counts.skippedByCascade, 0, 'what the cascade would have skipped for R1 and D1 is not asked of anyone');
  assert.equal(second.run.counts.cascadeEstimatedTokensAvoided, 0);
  assert.equal(second.run.counts.calls, 6);
  assert.equal(second.overlay.counts.reusedNegativeCallsAvoided, 2, 'the cascade made one call for each, and that is what the reuse spared');
  assert.deepEqual(second.run.reviews.filter(item => item.decision === 'accept').map(item => item.relationId), [A1, A2]);
  assert.ok((second.events[0]!.detail as any).cascade === true && (second.events[0]!.detail as any).calls.minimum === 2);
  // Without memory the cascade run is what it was.
  const plain = await review(undefined, scriptedNightshift().nightshift, { cascade: true });
  assert.equal(plain.run.counts.skippedByCascade, first.run.counts.skippedByCascade);
  assert.equal(plain.run.counts.calls, first.run.counts.calls);
});

test('N2: E5-02 stays as it was: the live models built by createCandidateReview still ask through the forced tool call, and a hit asks nobody', async () => {
  const store = fakeMemory(), request = (extra: object = {}) => ({ universeId: 'T', runId: 'r', executionMode: 'OFFLINE', dataOrigin: 'TEST', proposals: proposals(), tableColumns: {}, budget: budget(), now: () => '2026-10-25T00:00:00Z', ...extra }) as any;
  const first = scriptedNightshift();
  await createCandidateReview({ model: first.nightshift, thresholds: { minDistinctKeys: 3 }, contractDefaults: defaults, reviewDecisionMemory: store.memory })(request());
  const isAdversary = (item: { messages: { content: string }[] }) => /adversarial reviewer/.test(item.messages[0]!.content);
  const judgesForced = (requests: typeof first.requests) => requests.filter(item => !isAdversary(item)).every(item => item.options.tools?.length === 1 && item.options.toolChoice);
  assert.ok(first.requests.length === 10 && judgesForced(first.requests) && first.requests.filter(isAdversary).every(item => item.options.tools === undefined));
  const second = scriptedNightshift();
  const outcome = await createCandidateReview({ model: second.nightshift, thresholds: { minDistinctKeys: 3 }, contractDefaults: defaults })(request({ reviewDecisionMemory: store.memory }));
  assert.equal(second.requests.length, 6, 'the memory also arrives with the request, as the engine supplies it');
  assert.ok(judgesForced(second.requests), 'what is still asked of the judges goes through the forced tool call (the adversary answers in text, R10b)');
  assert.deepEqual(asked(second.requests).filter(id => id === R1 || id === D1), []);
  assert.equal((outcome.overlay as any).counts.reusedNegative, 2);
  assert.equal((outcome.overlay as any).start.transport, 'MIXED');
  assert.deepEqual((outcome.overlay as any).start.transports, { judges: 'TOOL_CALL', adversary: 'TEXT' });
  // An invalid tool-call answer is still INVALID, still charged, never recorded as a judgment, and never retried.
  const garbage = scriptedNightshift(() => '{"relationId":"x"');
  const bad = fakeMemory();
  const result = await review(bad.memory, garbage.nightshift, { structuredOutput: 'TOOL_CALL', items: [proposal('store_sales', 'ss_item_sk')] });
  assert.equal(garbage.requests.length, 2);
  assert.deepEqual(result.run.reviews[0]!.evaluations.map(item => item.status), ['INVALID', 'INVALID']);
  assert.equal(bad.recorded.length, 0, 'an answer that did not parse is not a judgment on the evidence');
  assert.equal(result.run.counts.tokens, 2 * 4400);
});

test('N2: only a judgment on the evidence is recorded: a failed call, an invalid answer or a budget skip never becomes a remembered rejection or deferral', async () => {
  const failing = fakeMemory();
  const failedCall = scriptedNightshift(messages => { if (JSON.parse(messages[1]!.content).packet.relationId === R1) throw new Error('gateway'); return panelAnswer(messages); });
  const result = await review(failing.memory, failedCall.nightshift);
  assert.equal(result.run.reviews.find(item => item.relationId === R1)!.evaluations[0]!.status, 'CALL_FAILED');
  assert.deepEqual(failing.recorded.map(item => item.relationId), [D1], 'R1 was deferred because its calls failed, not because a model judged it');
  const invalid = fakeMemory();
  await review(invalid.memory, scriptedNightshift(messages => JSON.parse(messages[1]!.content).packet.relationId === D1 ? 'not json' : panelAnswer(messages)).nightshift);
  assert.deepEqual(invalid.recorded.map(item => item.relationId), [R1], 'D1 was deferred because the answers did not parse');
  // The same test on the records themselves: every status that is not a judgment, and the approvals, the floor and the stand-ins.
  const done = await review(undefined, scriptedNightshift().nightshift);
  const rejected = done.run.reviews.find(item => item.relationId === R1)!, approved = done.run.reviews.find(item => item.relationId === A1)!, floor = done.run.reviews.find(item => item.relationId === F1)!;
  assert.equal(worthRecording(rejected), true);
  assert.equal(worthRecording(approved), false);
  assert.equal(worthRecording(floor), false, 'the evidence floor decides without a model');
  for (const status of ['INVALID', 'CALL_FAILED', 'SKIPPED_BUDGET'] as const) assert.equal(worthRecording({ ...rejected, evaluations: [{ ...rejected.evaluations[0]!, status }, rejected.evaluations[1]!] }), false, status);
  assert.equal(worthRecording({ ...rejected, adversary: { ...rejected.adversary, status: 'SKIPPED_BUDGET' } }), false);
  assert.equal(worthRecording({ ...rejected, provenance: 'STAND_IN_OFFLINE' }), false);
  const standIn = fakeMemory();
  await reviewBlindCandidates({ proposals: proposals(), universeId: 'T', context: { minDistinctKeys: 3 }, budget: budget(), config: { minDistinctKeys: 3 }, defaults, judges: [standInJudge('j1', 'SEMANTIC'), standInJudge('j2', 'SEMANTIC')], adversary: standInAdversary('adv'), allowStandIn: true, reviewDecisionMemory: standIn.memory });
  assert.equal(standIn.recorded.length, 0, 'a stand-in\'s rejections are never remembered');
});

test('N2: a memory that throws never stops the review or changes a decision', async () => {
  const broken: ReviewDecisionMemory = { lookup: () => { throw new Error('store down'); }, record: () => { throw new Error('store full'); } };
  const baseline = await review(undefined, scriptedNightshift().nightshift), result = await review(broken, scriptedNightshift().nightshift);
  assert.deepEqual(result.run.reviews.map(item => [item.relationId, item.decision]), baseline.run.reviews.map(item => [item.relationId, item.decision]));
  assert.equal(result.run.counts.calls, baseline.run.counts.calls, 'the review went on without it, in full');
  assert.equal(result.run.reusedDecisions!.length, 0);
  assert.ok(result.run.decisionMemory!.errors.some(line => /^lookup /.test(line)) && result.run.decisionMemory!.errors.includes('record: Error'));
  assert.ok(result.run.limitations.some(line => /review decision memory errors/.test(line)));
});

test('N2: the reviewer takes the memory directly too (runModelReview), and the origin of a reused decision is MODEL_REVIEWED, never a human review', async () => {
  const store = fakeMemory();
  const live = scriptedNightshift();
  const run = await runModelReview({ packets: packetsOf(), ...liveModels(live.nightshift), budget: budget(), config: { minDistinctKeys: 3 }, reviewDecisionMemory: store.memory });
  assert.equal(run.reviews.length, 5);
  const again = await runModelReview({ packets: packetsOf(), ...liveModels(scriptedNightshift().nightshift), budget: budget(), config: { minDistinctKeys: 3 }, reviewDecisionMemory: store.memory });
  assert.equal(again.reviews.length, 3);
  assert.ok(again.reusedDecisions!.every(item => item.origin === MODEL_REVIEWED && item.calls === 0 && item.tokens === 0));
  assert.equal(again.counts.reusedNegative, 2);
  assert.equal(again.status, 'COMPLETE');
  assert.ok(!(REASON_CODES as readonly string[]).includes(REUSED_REVIEW_DECISION_REASON), 'the reuse reason is the reviewer\'s: a model can neither cite it nor be offered it in a tool schema');
  // Everything reused: no model is needed and the run is still COMPLETE with the accounting intact.
  const all = fakeMemory();
  const everything = await runModelReview({ packets: packetsOf(proposals().slice(2, 4)), ...liveModels(scriptedNightshift().nightshift), budget: budget(), config: { minDistinctKeys: 3 }, reviewDecisionMemory: all.memory });
  const fully = scriptedNightshift();
  const reused = await runModelReview({ packets: packetsOf(proposals().slice(2, 4)), ...liveModels(fully.nightshift), budget: budget(), config: { minDistinctKeys: 3 }, reviewDecisionMemory: all.memory });
  assert.equal(everything.counts.reject + everything.counts.defer, 2);
  assert.equal(fully.requests.length, 0, 'not one call');
  assert.deepEqual({ status: reused.status, reviews: reused.reviews.length, calls: reused.counts.calls, tokens: reused.counts.tokens, reusedNegative: reused.counts.reusedNegative }, { status: 'COMPLETE', reviews: 0, calls: 0, tokens: 0, reusedNegative: 2 });
});

test('N2: the saving never claims more calls than this configuration would have made for the decision, and counts the tokens at the claim own rate', () => {
  const packet = packetsOf()[2]!, fingerprint = evidenceFingerprint(packet);
  const claim = (extra: Partial<ReviewDecisionClaim>): ReviewDecisionClaim => ({ decision: 'defer', evidenceFingerprint: fingerprint, promptVersion: MODEL_REVIEW_PROMPT_VERSION, reasons: ['SIBLING_BETTER_MATCH'], ...extra });
  // R10: a deferral that took both judges and the adversary (3 calls, 13,200 tokens) would cost judge A alone under the cascade.
  const cascaded = reusedDecision(packet, claim({ calls: 3, tokens: 13_200 }), fingerprint, 'defer', 1);
  assert.deepEqual([cascaded.callsAvoided, cascaded.tokensAvoided], [1, 4400]);
  assert.deepEqual([reusedDecision(packet, claim({ calls: 3, tokens: 13_200 }), fingerprint, 'defer', 2).callsAvoided, reusedDecision(packet, claim({ calls: 3, tokens: 13_200 }), fingerprint, 'defer', 2).tokensAvoided], [2, 8800]);
  // A claim that costs less than the configuration asks keeps its own figures; one with no figures falls back to the planning figure.
  assert.deepEqual([reusedDecision(packet, claim({ calls: 1, tokens: 4100 }), fingerprint, 'reject', 2).callsAvoided, reusedDecision(packet, claim({ calls: 1, tokens: 4100 }), fingerprint, 'reject', 2).tokensAvoided], [1, 4100]);
  const bare = reusedDecision(packet, claim({}), fingerprint, 'defer', 2);
  assert.deepEqual([bare.callsAvoided, bare.tokensAvoided, bare.calls, bare.tokens], [2, 2 * 4500, 0, 0]);
});

test('N2 with the engine ledger (createReviewDecisionMemory): pass 1 records, pass 2 on unchanged evidence asks only for the approvals; nothing reviewed is read as an approval', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(ROOT, '.concordia', 'review-n2-test-')), 'LOCAL-SYNTHETIC');
  try {
    const make = (runId: string) => createReviewDecisionMemory({ universeId: 'T', dir, origin: { executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' }, runId, now: () => '2026-10-26T00:00:00.000Z' });
    const one = make('pass-1'), first = scriptedNightshift();
    await review(one, first.nightshift);
    assert.equal(first.requests.length, 10);
    assert.deepEqual(readReviewDecisionLedger(dir).map(item => [item.relationId, item.decision]).sort(), [[D1, 'defer'], [R1, 'reject']].sort());
    assert.ok(readReviewDecisionLedger(dir).every(item => item.origin === 'MODEL_REVIEWED' && /^[0-9a-f]{64}$/.test(item.evidenceFingerprint) && item.promptVersion === MODEL_REVIEW_PROMPT_VERSION && item.models.includes('claude-sonnet-5')));
    const two = make('pass-2'), second = scriptedNightshift();
    const result = await review(two, second.nightshift);
    assert.equal(second.requests.length, 6, 'the approvals are asked again, the remembered refusals are not');
    assert.deepEqual({ reused: two.stats().reused, recorded: two.stats().recorded, invalidated: two.stats().invalidated }, { reused: 2, recorded: 0, invalidated: 0 });
    // The engine's claims carry no figures: the saving is valued at what this run measured per judge call (4,400 here), not at the planning figure.
    assert.deepEqual(result.run.reusedDecisions!.map(item => [item.callsAvoided, item.tokensAvoided, item.tokensBasis, item.recordedRunId]), [[2, 2 * 4400, 'OBSERVED_THIS_RUN', 'pass-1'], [2, 2 * 4400, 'OBSERVED_THIS_RUN', 'pass-1']]);
    // Changed evidence invalidates the remembered no (history kept) and the relation is reviewed again.
    const three = make('pass-3'), third = scriptedNightshift();
    await review(three, third.nightshift, { items: proposals().map(item => item.proposalId === R1 ? proposal('store_sales', 'ss_item_sk', { distinctKeys: 4 }) : item) });
    assert.ok(asked(third.requests).includes(R1));
    assert.ok(three.stats().invalidated >= 1 && three.stats().invalidatedIds.includes(R1));
  } finally { fs.rmSync(path.dirname(dir), { recursive: true, force: true }); }
});
