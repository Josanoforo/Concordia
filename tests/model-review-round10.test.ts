import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { classifyAttacks } from '../src/agent/model-review/aggregate.ts';
import { reviewBlindCandidates } from '../src/agent/model-review/candidates.ts';
import { createCandidateReview } from '../src/agent/model-review/candidate-review.ts';
import { deterministicAttacks } from '../src/agent/model-review/deterministic-attacks.ts';
import { buildPackets, wilsonBound, type ProbedProposalInput, type TieBreakResolver } from '../src/agent/model-review/evidence.ts';
import { reviewPriority } from '../src/agent/model-review/priority.ts';
import { parseAttacks } from '../src/agent/model-review/prompts.ts';
import { estimateModelReviewCost, runModelReview } from '../src/agent/model-review/reviewer.ts';
import { attackAnswer, judgeAnswer, StandInModel, standInAdversary, standInJudge } from '../src/agent/model-review/standin.ts';
import type { GlobalUniqueness, ModelMessage, ReviewCall, ReviewModel, ReviewPacket } from '../src/agent/model-review/types.ts';
import { RunBudget } from '../src/agent/run-budget.ts';
import type { CandidateReviewRequest } from '../src/agent/model-review-contract.ts';
import { loadF04Set, MIN_DISTINCT_KEYS } from './helpers/model-review-f04.ts';

/**
 * Round 10, phases A and B of the model reviewer (X8): E5-01 cascade, E5-03 computed attack families, E5-07 model table per role, E5-08 priority order, E3-04 Wilson bound,
 * the tie-break of X10 in the packet and in the SIBLING refutation, E2-04 roles. Everything is offline: stand-ins and replays of recorded answers.
 */
interface Recorded { relationId: string; stage: 'EVALUATION' | 'ATTACK'; slot: number; actor: string; outputTokens: number; responseText: string }
const here = path.resolve(import.meta.dirname, 'fixtures', 'model-review');
const one = JSON.parse(fs.readFileSync(path.join(here, 'nwch-live-01.json'), 'utf8')) as { proposals: any[]; responses: Recorded[] };
const two = JSON.parse(fs.readFileSync(path.join(here, 'nwch-live-02.json'), 'utf8')) as { responses: Recorded[] };
const defaults = { universeId: 'NWCH', database: 'NWCH_DB', normalization: 'text', normalizationVersion: 'text-exact-v1', normalizationAdapterCapability: 'exact-text' };
const ARTIST = 'chinook_album.ArtistId__chinook_artist.ArtistId', TRACK = 'chinook_album.ArtistId__chinook_playlist_track.TrackId';
const F1: Record<string, GlobalUniqueness> = { 'chinook_playlist_track.TrackId': 'NOT_UNIQUE', 'chinook_artist.ArtistId': 'UNIQUE', 'northwind_orders.OrderID': 'UNIQUE', 'northwind_products.ProductID': 'UNIQUE' };
const relationOf = (messages: readonly ModelMessage[]) => JSON.parse(messages[1]!.content).packet.relationId as string;
const budget = (tokens = 5_000_000) => new RunBudget({ maxQueriesPerRun: 5, readLimit: 50, maxTokensPerRun: tokens, maxSteps: 3 });
const live = (model: StandInModel) => Object.assign(model, { kind: 'LIVE_MODEL' as const }) as ReviewModel;
const migrate = (text: string) => { try { const value = JSON.parse(text); return value.decision === 'accept' ? JSON.stringify({ ...value, reasonCodes: value.reasonCodes.map((code: string) => code === 'SIBLING_BETTER_MATCH' ? 'SIBLINGS_WEAKER' : code) }) : text; } catch { return text; } };

/** Replays a recorded live capture for (stage, slot). */
function replay(recorded: Recorded[], id: string, stage: 'EVALUATION' | 'ATTACK', slot: number, cap: number, transform: (text: string) => string = text => text, fallback?: (messages: readonly ModelMessage[]) => string): ReviewModel {
  return live(new StandInModel(id, messages => {
    const found = recorded.find(item => item.relationId === relationOf(messages) && item.stage === stage && item.slot === slot);
    if (found) return { status: 'PASS', responseText: transform(found.responseText), receipt: { receiptId: 'replay', provider: 'replay', model: 'replay', inputTokens: 1000, outputTokens: found.outputTokens, totalTokens: 1000 + found.outputTokens, latencyMs: 0, fromCache: false }, truncated: found.outputTokens >= cap };
    return fallback ? fallback(messages) : { status: 'FAIL', error: { code: 'NOT_RECORDED' } };
  }));
}
const replayRun = (which: 'one' | 'two', cascade: boolean, globalTargetUniqueness?: Record<string, GlobalUniqueness>, tieBreak?: TieBreakResolver) => {
  const recorded = which === 'one' ? one.responses : two.responses, cap = which === 'one' ? 400 : 2000, transform = which === 'one' ? migrate : undefined;
  // Relations the capture never judged (the homonyms in live-02) and the cut adversary answers of live-01 are answered by the offline stand-ins, labelled as such below.
  const standInAttack = (messages: readonly ModelMessage[]) => attackAnswer(JSON.parse(messages[1]!.content).packet);
  const standInJudgeAnswer = (messages: readonly ModelMessage[]) => judgeAnswer('SEMANTIC', JSON.parse(messages[1]!.content).packet);
  const proposals = one.proposals;
  return reviewBlindCandidates({ proposals, universeId: 'NWCH', context: { minDistinctKeys: 3, ...(globalTargetUniqueness ? { globalTargetUniqueness } : {}), ...(tieBreak ? { tieBreak } : {}) },
    judges: [replay(recorded, 'judge-a', 'EVALUATION', 0, cap, transform, which === 'two' ? standInJudgeAnswer : undefined), replay(recorded, 'judge-b', 'EVALUATION', 1, cap, transform, which === 'two' ? standInJudgeAnswer : undefined)],
    adversary: which === 'one' ? live(new StandInModel('adversary', standInAttack)) : replay(recorded, 'adversary', 'ATTACK', 0, cap, undefined, standInAttack), budget: budget(), config: { minDistinctKeys: 3, cascade }, defaults });
};

// ------------------------------------------------------------------ E5-01 cascade
test('E5-01: the cascade gives the same decisions and contracts as the full panel on the NWCH live-01 and live-02 replays, with fewer calls and fewer tokens', async () => {
  for (const which of ['one', 'two'] as const) {
    const full = await replayRun(which, false, F1), cheap = await replayRun(which, true, F1);
    const decisions = (result: typeof full) => result.run.reviews.map(review => [review.relationId, review.decision]);
    assert.deepEqual(decisions(cheap), decisions(full), `${which}: identical decisions`);
    assert.deepEqual(cheap.contracts.map(contract => contract.id).sort(), full.contracts.map(contract => contract.id).sort(), `${which}: identical contracts`);
    assert.ok(cheap.run.counts.calls < full.run.counts.calls, `${which}: ${cheap.run.counts.calls} calls against ${full.run.counts.calls}`);
    assert.ok(cheap.run.counts.tokens < full.run.counts.tokens);
    assert.equal(full.run.counts.skippedByCascade, 0); assert.equal(full.run.config.cascade, false);
    assert.equal(cheap.run.config.cascade, true); assert.ok(cheap.run.counts.skippedByCascade >= full.run.counts.calls - cheap.run.counts.calls, 'every call the cascade did not make is recorded as skipped, none is lost');
    assert.ok(cheap.run.counts.cascadeEstimatedTokensAvoided > 0);
  }
});

test('E5-01: a skipped call is recorded as SKIPPED_BY_CASCADE in the review, the trace, the model table and the overlay; nothing is charged for it', async () => {
  const cheap = await replayRun('one', true);
  const rejected = cheap.run.reviews.find(review => review.decision === 'reject' && review.floor.cap === 'accept' && review.evaluations.length === 2)!;
  assert.deepEqual(rejected.evaluations.map(item => item.status), ['VALID', 'SKIPPED_BY_CASCADE']);
  assert.deepEqual([rejected.evaluations[1]!.call!.status, rejected.evaluations[1]!.tokens, rejected.adversary.status], ['SKIPPED_BY_CASCADE', 0, 'SKIPPED_BY_CASCADE']);
  assert.ok(rejected.notes.some(note => note.includes('skipped by the cascade')));
  const events = cheap.run.trace.filter(event => event.callStatus === 'SKIPPED_BY_CASCADE');
  assert.equal(events.length, cheap.run.counts.skippedByCascade);
  assert.ok(events.every(event => event.tokens === 0 && typeof event.estimatedTokens === 'number' && event.estimatedTokens > 0 && event.promptHash === undefined), 'a call that was never sent has no prompt hash');
  assert.equal(cheap.overlay.counts.skippedByCascade, cheap.run.counts.skippedByCascade);
  assert.equal(cheap.overlay.modelTable.find(row => row.role === 'judge-b')!.skippedByCascade, cheap.run.reviews.filter(review => review.evaluations[1]?.status === 'SKIPPED_BY_CASCADE').length);
  assert.ok(cheap.overlay.modelTable.find(row => row.role === 'adversary')!.skippedByCascade > 0);
  assert.equal(cheap.overlay.config.cascade, true);
});

test('E5-01: judge A accepts and judge B defers is still a defer, and the adversary is skipped; both accept runs the adversary and accepts', async () => {
  const packet = buildPackets(one.proposals, { minDistinctKeys: 3 }).packets.find(item => item.relationId.includes('northwind_orders.OrderID'))!;
  const answer = (decision: string) => (messages: readonly ModelMessage[]) => JSON.stringify({ relationId: relationOf(messages), decision, confidence: 'high', reasonCodes: decision === 'accept' ? ['NAME_ENTITY_MATCH', 'KEY_MEMBERSHIP_COMPLETE'] : ['SEMANTICS_NOT_ESTABLISHED'], rationale: 'x' });
  const adversary = new StandInModel('adv', messages => attackAnswer(JSON.parse(messages[1]!.content).packet));
  const split = await runModelReview({ packets: [packet], judges: [new StandInModel('a', answer('accept')), new StandInModel('b', answer('defer'))], adversary, budget: budget(), config: { minDistinctKeys: 3, cascade: true } });
  assert.equal(split.reviews[0]!.decision, 'defer'); assert.equal(split.reviews[0]!.adversary.status, 'SKIPPED_BY_CASCADE'); assert.equal(split.reviews[0]!.adversarialPass, 'NOT_NEEDED'); assert.equal(adversary.calls, 0);
  const both = await runModelReview({ packets: [packet], judges: [new StandInModel('a', answer('accept')), new StandInModel('b', answer('accept'))], adversary, budget: budget(), config: { minDistinctKeys: 3, cascade: true } });
  assert.equal(both.reviews[0]!.decision, 'accept'); assert.equal(both.reviews[0]!.adversarialPass, 'COMPLETED'); assert.equal(adversary.calls, 1);
  assert.equal(both.counts.skippedByCascade, 0);
});

test('E5-01: a failed or invalid first judge stops the cascade (defer); the cascade is off by default', async () => {
  const packet = buildPackets(one.proposals, { minDistinctKeys: 3 }).packets.find(item => item.relationId.includes('northwind_orders.OrderID'))!;
  const broken = new StandInModel('a', () => 'not json'), second = new StandInModel('b', messages => judgeAnswer('SEMANTIC', JSON.parse(messages[1]!.content).packet));
  const cascaded = await runModelReview({ packets: [packet], judges: [broken, second], adversary: standInAdversary('adv'), budget: budget(), config: { minDistinctKeys: 3, cascade: true } });
  assert.deepEqual(cascaded.reviews[0]!.evaluations.map(item => item.status), ['INVALID', 'SKIPPED_BY_CASCADE']); assert.equal(cascaded.reviews[0]!.decision, 'defer'); assert.equal(second.calls, 0);
  const full = await runModelReview({ packets: [packet], judges: [new StandInModel('a', () => 'not json'), second], adversary: standInAdversary('adv'), budget: budget(), config: { minDistinctKeys: 3 } });
  assert.equal(second.calls, 1, 'without the cascade the second judge is asked anyway'); assert.equal(full.counts.skippedByCascade, 0);
  const cost = estimateModelReviewCost([packet], 2, { attackScope: 'ACCEPTED_ONLY', cascade: true });
  assert.ok(cost.cascadeMinimumTokens! > 0 && cost.cascadeMinimumTokens! < cost.estimatedTokens);
});

test('E5-01: through the factory, the 25 F-04 true relations are approved with and without the cascade, and the cascade makes fewer calls', async () => {
  const thresholds = { minDistinctKeys: MIN_DISTINCT_KEYS };
  const request = (): CandidateReviewRequest => ({ universeId: 'TPCDS', runId: 'agent-r', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', proposals: loadF04Set().proposals as unknown[], tableColumns: {}, budget: budget(1_000_000), now: () => '2026-10-26T00:00:00.000Z' });
  const full = await createCandidateReview({ standIn: true, thresholds })(request()), cheap = await createCandidateReview({ standIn: true, thresholds, config: { cascade: true } })(request());
  assert.deepEqual(cheap.contracts.map(contract => contract.id).sort(), full.contracts.map(contract => contract.id).sort()); assert.equal(cheap.contracts.length, 25);
  assert.ok((cheap.overlay as any).counts.calls < (full.overlay as any).counts.calls);
  assert.ok((cheap.overlay as any).counts.skippedByCascade > 0);
});

// ------------------------------------------------------------------ E5-03 computed attack families
const packetOf = (over: Partial<ReviewPacket> = {}): ReviewPacket => ({
  relationId: 'catalog_sales.cs_item_sk__item.i_item_sk', source: { table: 'catalog_sales', column: 'cs_item_sk' }, target: { table: 'item', column: 'i_item_sk' }, orientation: 'AS_PROPOSED',
  coverage: { level: 'HIGH', matched: 19, probed: 19, threshold: 0.8 }, sourceKeys: { rows: 20, distinctKeys: 19, maxRowsPerKey: 2 }, targetKeys: { rows: 19, distinctKeys: 19, maxRowsPerKey: 1 },
  keyRules: { inclusion: 'NO_VIOLATION_IN_SAMPLE', missingCount: 0, targetUniqueness: 'NO_DUPLICATES_IN_SAMPLE', duplicateKeyCount: 0 }, labels: { signal: 'NOT_COMPARABLE' }, minDistinctKeys: 3, siblings: [], negativeControl: [], limitations: [], ...over });

test('E5-03: INSUFFICIENT_KEYS and INVERTED_ORIENTATION come from the packet: below the minimum blocks, at the minimum is minor, a repeated target against a unique source blocks', () => {
  const byFamily = (packet: ReviewPacket) => Object.fromEntries(deterministicAttacks(packet).map(attack => [attack.family, attack]));
  assert.deepEqual(Object.keys(byFamily(packetOf())), ['INSUFFICIENT_KEYS', 'INVERTED_ORIENTATION']);
  assert.ok(deterministicAttacks(packetOf()).every(attack => attack.outcome === 'NO_ATTACK' && attack.source === 'DETERMINISTIC' && attack.tokens === 0));
  assert.deepEqual([byFamily(packetOf({ sourceKeys: { rows: 5, distinctKeys: 2, maxRowsPerKey: 1 } })).INSUFFICIENT_KEYS!.outcome, byFamily(packetOf({ sourceKeys: { rows: 5, distinctKeys: 3, maxRowsPerKey: 1 } })).INSUFFICIENT_KEYS!.outcome], ['SUSTAINED', 'SURVIVED']);
  const inverted = byFamily(packetOf({ structure: { sourceShape: 'UNIQUE_IN_SAMPLE', targetShape: 'DUPLICATES_OBSERVED', rankClass: 'KEY_CANDIDATE', targetDeclaredKey: false } })).INVERTED_ORIENTATION!;
  assert.deepEqual([inverted.outcome, inverted.recommend, inverted.evidenceRefs], ['SUSTAINED', 'defer', ['structure']]);
  assert.equal(byFamily(packetOf({ target: { table: 'item', column: 'i_item_sk', globalUniqueness: 'NOT_UNIQUE' } })).INVERTED_ORIENTATION!.recommend, 'reject');
  assert.equal(byFamily(packetOf({ orientation: 'SWAPPED_TARGET_UNIQUE', structure: { sourceShape: 'UNIQUE_IN_SAMPLE', targetShape: 'UNIQUE_IN_SAMPLE', rankClass: 'KEY_TO_KEY', targetDeclaredKey: false } })).INVERTED_ORIENTATION!.outcome, 'SURVIVED');
});

test('E5-03: a computed attack that blocks lowers the decision and the adversary is not asked; the adversary model answers two families, and its entries for the computed ones are ignored', async () => {
  const inverted = packetOf({ structure: { sourceShape: 'UNIQUE_IN_SAMPLE', targetShape: 'DUPLICATES_OBSERVED', rankClass: 'KEY_CANDIDATE', targetDeclaredKey: false } });
  const adversary = new StandInModel('adv', messages => attackAnswer(JSON.parse(messages[1]!.content).packet));
  const result = await runModelReview({ packets: [inverted], judges: [standInJudge('a', 'SEMANTIC'), standInJudge('b', 'SEMANTIC')], adversary, budget: budget(), config: { minDistinctKeys: 3 } });
  const review = result.reviews[0]!;
  assert.equal(adversary.calls, 0, 'the packet already decides: the call could change nothing');
  assert.equal(review.decision, 'defer'); assert.ok(review.reasons.includes('ORIENTATION_DOUBTFUL')); assert.equal(review.adversary.status, 'NOT_NEEDED');
  assert.equal(review.adversary.attacks.find(attack => attack.family === 'INVERTED_ORIENTATION')!.outcome, 'SUSTAINED');
  assert.ok(review.attacksSustained.every(attack => attack.source === 'DETERMINISTIC'));

  const accepted = await runModelReview({ packets: [packetOf()], judges: [standInJudge('a', 'SEMANTIC'), standInJudge('b', 'SEMANTIC')], adversary, budget: budget(), config: { minDistinctKeys: 3 } });
  assert.equal(accepted.reviews[0]!.decision, 'accept'); assert.equal(adversary.calls, 1);
  assert.deepEqual(accepted.reviews[0]!.adversary.attacks.map(attack => attack.family), ['HOMONYM', 'INSUFFICIENT_KEYS', 'SIBLING', 'INVERTED_ORIENTATION']);
  assert.deepEqual(JSON.parse(attackAnswer(packetOf())).attacks.map((attack: any) => attack.family), ['HOMONYM', 'SIBLING'], 'the stand-in adversary, like the v3 prompt, answers only the two model families');
  // A legacy four-family answer that tries to block on a computed family changes nothing: the entry is dropped at parse time.
  const none = (family: string) => ({ family, severity: 'none', recommend: 'keep', argument: '', evidenceRefs: [] });
  const legacy = { relationId: packetOf().relationId, attacks: [none('HOMONYM'), { family: 'INSUFFICIENT_KEYS', severity: 'blocking', recommend: 'reject', argument: 'x', evidenceRefs: ['sourceKeys'] }, none('SIBLING'), none('INVERTED_ORIENTATION')] };
  assert.deepEqual(parseAttacks(JSON.stringify(legacy), packetOf().relationId)!.map(attack => attack.family), ['HOMONYM', 'SIBLING']);
  const legacyAdversary = new StandInModel('legacy', () => JSON.stringify(legacy));
  const survived = await runModelReview({ packets: [packetOf()], judges: [standInJudge('a', 'SEMANTIC'), standInJudge('b', 'SEMANTIC')], adversary: legacyAdversary, budget: budget(), config: { minDistinctKeys: 3 } });
  assert.equal(survived.reviews[0]!.decision, 'accept'); assert.equal(survived.reviews[0]!.attacksSustained.length, 0);
});

// ------------------------------------------------------------------ E5-07 model table
test('E5-07: the model table lists, per role, the model ids the receipts report and the counts of calls, invalid, truncated and tokens', async () => {
  const wanted = [ARTIST, 'northwind_order_details.OrderID__northwind_orders.OrderID', 'northwind_order_details.ProductID__northwind_products.ProductID'];
  const packets = buildPackets(one.proposals, { minDistinctKeys: 3, globalTargetUniqueness: F1 }).packets.filter(item => wanted.includes(item.relationId));
  assert.equal(packets.length, 3);
  let n = 0;
  const reply = (model: string, decisionFor: (relationId: string) => ReviewCall | string) => (messages: readonly ModelMessage[]) => { n++; const out = decisionFor(relationOf(messages)); return typeof out === 'string' ? { status: 'PASS', responseText: out, receipt: { receiptId: `r${n}`, provider: 'p', model, inputTokens: 700, outputTokens: 300, totalTokens: 1000, latencyMs: 1, fromCache: false } } : out; };
  const accept = (relationId: string) => JSON.stringify({ relationId, decision: 'accept', confidence: 'high', reasonCodes: ['NAME_ENTITY_MATCH', 'KEY_MEMBERSHIP_COMPLETE'], rationale: 'x' });
  const judgeA = Object.assign(new StandInModel('judge-a', reply('model-x', accept)), { requestedModel: 'meterless/route-1' });
  // judge-b: the alias resolved to two different models, one answer is cut at the cap, one is not JSON.
  let b = 0;
  const judgeB = new StandInModel('judge-b', messages => { b++; return b === 1 ? { status: 'PASS', responseText: '{"relationId":', truncated: true, receipt: { receiptId: 'rb1', provider: 'p', model: 'model-y', inputTokens: 700, outputTokens: 1500, totalTokens: 2200, latencyMs: 1, fromCache: false } } : b === 2 ? reply('model-z', () => 'prose')(messages) : reply(b % 2 ? 'model-y' : 'model-z', accept)(messages); });
  const adversary = Object.assign(new StandInModel('adversary', messages => JSON.stringify({ relationId: relationOf(messages), attacks: [{ family: 'HOMONYM', severity: 'none', recommend: 'keep', argument: '', evidenceRefs: [] }, { family: 'SIBLING', severity: 'none', recommend: 'keep', argument: '', evidenceRefs: [] }] })), { requestedModel: 'meterless/other-family' });
  const result = await runModelReview({ packets, judges: [judgeA, judgeB], adversary, budget: budget(), config: { minDistinctKeys: 3 } });
  const [rowA, rowB, rowAdv] = result.modelTable;
  assert.deepEqual(result.modelTable.map(row => row.role), ['judge-a', 'judge-b', 'adversary']);
  assert.deepEqual([rowA!.actor, rowA!.requestedModel, rowA!.models, rowA!.calls, rowA!.invalid, rowA!.truncated, rowA!.tokens], ['judge-a', 'meterless/route-1', [{ model: 'model-x', calls: 3 }], 3, 0, 0, 3000]);
  assert.equal(rowB!.calls, 3); assert.equal(rowB!.invalid, 2, 'one cut answer and one prose answer'); assert.equal(rowB!.truncated, 1);
  assert.equal(rowB!.models.reduce((sum, item) => sum + item.calls, 0), 3); assert.ok(rowB!.models.length >= 2, 'the alias answered with more than one model and the table says so');
  assert.equal(rowB!.inputTokens + rowB!.outputTokens, rowB!.tokens);
  assert.equal(rowAdv!.requestedModel, 'meterless/other-family'); assert.ok(rowAdv!.calls >= 1);
  assert.equal(result.modelTable.reduce((sum, row) => sum + row.tokens, 0), result.counts.tokens, 'the table accounts for every token of the run');
});

test('E5-07: the table is in the overlay the report reads, with the same rows as the run', async () => {
  const result = await replayRun('one', false, F1);
  assert.deepEqual(result.overlay.modelTable, result.run.modelTable); assert.equal(result.overlay.modelTable.length, 3);
  assert.deepEqual(result.overlay.modelTable.map(row => row.role), ['judge-a', 'judge-b', 'adversary']);
  assert.equal(result.overlay.modelTable[0]!.models[0]!.model, 'replay');
});

// ------------------------------------------------------------------ E5-08 priority
test('E5-08: relations are ordered by key class, declared target, name affinity and few siblings; reviews still come back in input order', () => {
  const p = (id: string, column: string, table: string, over: Partial<ReviewPacket> = {}) => packetOf({ relationId: id, source: { table: 'fact', column }, target: { table, column: 'k' }, ...over });
  const structure = (rankClass: string, declared: boolean) => ({ sourceShape: 'DUPLICATES_OBSERVED', targetShape: 'UNIQUE_IN_SAMPLE', rankClass, targetDeclaredKey: declared });
  const sibling = { relationId: 'x', shares: 'SOURCE' as const, other: { table: 'o', column: 'k' }, executed: true };
  const packets = [
    p('dup', 'f_store_sk', 'store', { structure: structure('BOTH_SIDES_DUPLICATED', true) }),
    p('plain', 'f_store_sk', 'store', { structure: structure('KEY_CANDIDATE', false) }),
    p('named-lonely', 'f_store_sk', 'store', { structure: structure('KEY_CANDIDATE', true) }),
    p('named-sibling', 'f_store_sk', 'store', { structure: structure('KEY_CANDIDATE', true), siblings: [sibling] }),
    p('unnamed', 'f_store_sk', 'web_site', { structure: structure('KEY_CANDIDATE', true) }),
    p('key-to-key', 'f_store_sk', 'store', { structure: structure('KEY_TO_KEY', true) })
  ];
  const order = reviewPriority(packets);
  assert.deepEqual(order.map(entry => entry.relationId), ['named-lonely', 'named-sibling', 'unnamed', 'plain', 'key-to-key', 'dup']);
  assert.deepEqual(order.map(entry => entry.rank), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(reviewPriority(packets.map(item => ({ ...item, structure: undefined }))).map(entry => entry.relationId), ['dup', 'plain', 'named-lonely', 'key-to-key', 'named-sibling', 'unnamed'], 'without structure: name affinity, then fewer siblings, then input order');
});

test('E5-08: when the budget runs out the least promising relations are the ones skipped, listed with their rank; the best is fully reviewed', async () => {
  const structure = (rankClass: string, declared: boolean) => ({ sourceShape: 'DUPLICATES_OBSERVED', targetShape: 'UNIQUE_IN_SAMPLE', rankClass, targetDeclaredKey: declared });
  const make = (id: string, rankClass: string, declared: boolean, table: string) => packetOf({ relationId: id, source: { table: 'fact', column: 'f_store_sk' }, target: { table, column: 'k' }, structure: structure(rankClass, declared) });
  const packets = [make('low', 'BOTH_SIDES_DUPLICATED', false, 'web_site'), make('mid', 'KEY_TO_KEY', false, 'store'), make('best', 'KEY_CANDIDATE', true, 'store')];
  // Each call reports 10000 tokens; the budget fits the three calls of one relation and not the next one.
  const heavy = (inner: (m: readonly ModelMessage[]) => string) => (messages: readonly ModelMessage[]): ReviewCall => ({ status: 'PASS', responseText: inner(messages), receipt: { receiptId: 'r', provider: 'p', model: 'm', inputTokens: 5000, outputTokens: 5000, totalTokens: 10000, latencyMs: 1, fromCache: false } });
  const judge = (id: string) => new StandInModel(id, heavy(messages => judgeAnswer('SEMANTIC', JSON.parse(messages[1]!.content).packet)));
  const adversary = new StandInModel('adv', heavy(messages => attackAnswer(JSON.parse(messages[1]!.content).packet)));
  const result = await runModelReview({ packets, judges: [judge('a'), judge('b')], adversary, budget: budget(31_000), config: { minDistinctKeys: 3 } });
  assert.equal(result.status, 'PARTIAL_BUDGET');
  assert.deepEqual(result.priority.order.map(entry => entry.relationId), ['best', 'mid', 'low']);
  assert.deepEqual(result.reviews.map(review => review.relationId), ['low', 'mid', 'best'], 'input order is kept');
  const byId = new Map(result.reviews.map(review => [review.relationId, review]));
  assert.equal(byId.get('best')!.decision, 'accept'); assert.equal(byId.get('best')!.calls, 3);
  assert.deepEqual(result.priority.skipped.map(entry => [entry.relationId, entry.rank, entry.reason]), [['mid', 2, 'SKIPPED_BUDGET'], ['low', 3, 'SKIPPED_BUDGET']]);
  assert.ok(byId.get('mid')!.decision === 'defer' && byId.get('low')!.decision === 'defer');
  assert.ok(result.trace.some(event => event.kind === 'model-review-run' && JSON.stringify((event.detail as any).prioritySkipped) === JSON.stringify([{ relationId: 'mid', rank: 2 }, { relationId: 'low', rank: 3 }])));
});

// ------------------------------------------------------------------ E3-04 Wilson
test('E3-04: the packet carries the Wilson interval of matched/probed; 5 of 5 and 49 of 49 have the same rate and different bounds; the floor does not read it', () => {
  const five = wilsonBound(5, 5)!, many = wilsonBound(49, 49)!;
  assert.ok(five.lower > 0.55 && five.lower < 0.58 && five.upper === 1, JSON.stringify(five));
  assert.ok(many.lower > 0.92 && many.lower < 0.94 && many.upper === 1, JSON.stringify(many));
  assert.deepEqual([wilsonBound(0, 0), wilsonBound(3, 2), wilsonBound(-1, 4)], [undefined, undefined, undefined]);
  assert.ok(wilsonBound(0, 10)!.lower === 0 && wilsonBound(0, 10)!.upper > 0.2 && wilsonBound(0, 10)!.upper < 0.35);
  assert.deepEqual([five.confidence, five.method], [0.95, 'wilson']);
  const packets = buildPackets(one.proposals, { minDistinctKeys: 3 }).packets;
  for (const packet of packets) assert.deepEqual(packet.coverage.wilson, wilsonBound(packet.coverage.matched, packet.coverage.probed), packet.relationId);
  assert.ok(packets.some(packet => packet.coverage.wilson !== undefined));
});

// ------------------------------------------------------------------ E2-04 roles
const probed = (from: [string, string], to: [string, string], over: Partial<ProbedProposalInput> = {}): ProbedProposalInput => ({ proposalId: `${from[0]}.${from[1]}__${to[0]}.${to[1]}`, from: { table: from[0], column: from[1] }, to: { table: to[0], column: to[1] },
  coverageProbe: { status: 'EXECUTED', diagnostic: { coverage: { level: 'HIGH', matched: 15, probed: 15, threshold: 0.8 }, multiplicity: { from: { rows: 20, distinctKeys: 15, maxRowsPerKey: 2 }, to: { rows: 15, distinctKeys: 15, maxRowsPerKey: 1 } }, keyRules: { inclusion: { status: 'NO_VIOLATION_IN_SAMPLE', missingCount: 0 }, targetUniqueness: { status: 'NO_DUPLICATES_IN_SAMPLE' } } } }, ...over });
const SOLD = 'catalog_sales.cs_sold_date_sk__date_dim.d_date_sk', SHIP = 'catalog_sales.cs_ship_date_sk__date_dim.d_date_sk', WEB = 'web_sales.ws_sold_date_sk__date_dim.d_date_sk';
const dateProposals = () => [probed(['catalog_sales', 'cs_sold_date_sk'], ['date_dim', 'd_date_sk']), probed(['catalog_sales', 'cs_ship_date_sk'], ['date_dim', 'd_date_sk']), probed(['web_sales', 'ws_sold_date_sk'], ['date_dim', 'd_date_sk'])];

test('E2-04: several columns of one source table pointing at the same dimension are marked as roles in the packet, not as competing siblings', () => {
  const { packets } = buildPackets(dateProposals(), { minDistinctKeys: 3 }), sold = packets.find(item => item.relationId === SOLD)!;
  assert.deepEqual(sold.roles, { target: { table: 'date_dim', column: 'd_date_sk' }, sourceColumns: ['cs_sold_date_sk', 'cs_ship_date_sk'] });
  const ship = sold.siblings.find(item => item.relationId === SHIP)!, web = sold.siblings.find(item => item.relationId === WEB)!;
  assert.equal(ship.role, true); assert.equal(web.role, undefined, 'another table pointing at the dimension is not a role of this source table');
  assert.equal(packets.find(item => item.relationId === WEB)!.roles, undefined);
  assert.equal(buildPackets([dateProposals()[0]!], { minDistinctKeys: 3 }).packets[0]!.roles, undefined);
});

test('E2-04: a SIBLING attack that cites only roles is refuted; one that also cites a non-role sibling still stands', () => {
  const sold = buildPackets(dateProposals(), { minDistinctKeys: 3 }).packets.find(item => item.relationId === SOLD)!;
  const shipIndex = sold.siblings.findIndex(item => item.relationId === SHIP), webIndex = sold.siblings.findIndex(item => item.relationId === WEB);
  const attack = (refs: string[]) => ({ family: 'SIBLING' as const, severity: 'blocking' as const, recommend: 'defer' as const, argument: 'x', evidenceRefs: refs });
  assert.equal(classifyAttacks(sold, [attack([`siblings[${shipIndex}]`])])[0]!.outcome, 'REFUTED');
  assert.equal(classifyAttacks(sold, [attack([`siblings[${shipIndex}]`, `siblings[${webIndex}]`])])[0]!.outcome, 'SUSTAINED');
  assert.equal(classifyAttacks(sold, [attack([`siblings[${webIndex}]`])])[0]!.outcome, 'SUSTAINED');
});

test('E2-04: end to end, an adversary that raises the role as a better sibling does not stop the multi-role foreign key', async () => {
  const proposals = dateProposals().slice(0, 2);
  const packets = buildPackets(proposals, { minDistinctKeys: 3 }).packets;
  const adversary = new StandInModel('adv', messages => { const packet = JSON.parse(messages[1]!.content).packet as ReviewPacket, index = packet.siblings.findIndex(item => item.role);
    return JSON.stringify({ relationId: packet.relationId, attacks: [{ family: 'HOMONYM', severity: 'none', recommend: 'keep', argument: '', evidenceRefs: [] }, { family: 'SIBLING', severity: 'blocking', recommend: 'defer', argument: 'the ship date column is a better fit', evidenceRefs: [`siblings[${index}]`] }] }); });
  const judges = [standInJudge('a', 'SEMANTIC'), standInJudge('b', 'SEMANTIC')];
  const result = await runModelReview({ packets, judges, adversary, budget: budget(), config: { minDistinctKeys: 3 } });
  assert.deepEqual(result.reviews.map(review => review.decision), ['accept', 'accept']);
  assert.ok(result.reviews.every(review => review.attacksSurvived.some(attack => attack.family === 'SIBLING' && attack.outcome === 'REFUTED')));
});

// ------------------------------------------------------------------ tie-break of X10
/** Stub of X10's orderTies for the ArtistId tie only; any other group has no answer. */
const tie = (decisive: boolean, ordered: string[]): TieBreakResolver => group => (group.includes(ARTIST) && group.includes(TRACK) ? { ordered, decisive, reason: decisive ? 'name asymmetry and distinct ratio' : 'traits do not separate' } : undefined);

test('tie-break: the packet carries the compact block (winner, decisive, deciding step and values); the whole order and traits go to the audit; the resolver sees this relation plus the candidates sharing its source', () => {
  const seen: (readonly string[])[] = [];
  const resolver: TieBreakResolver = grp => { seen.push(grp); return { ordered: [ARTIST, TRACK, ...grp.filter(id => id !== ARTIST && id !== TRACK)], decisive: true, reason: 'DECIDED_BY_NAME_VS_TABLE: long sentence', decidedBy: 'NAME_VS_TABLE',
    trace: [{ step: 'NAME_VS_TABLE', outcome: 'SEPARATED', values: { [ARTIST]: '1', [TRACK]: '0' }, eliminated: [TRACK] }], vectors: { [ARTIST]: { distinctRatio: 1, nameAsymmetry: 'TARGET_NAMED', rangeBias: null, nested: { dropped: true } }, 'not-in-group': { x: 1 } } }; };
  const built = buildPackets(one.proposals, { minDistinctKeys: 3, tieBreak: resolver }), packet = built.packets.find(item => item.relationId === ARTIST)!;
  assert.ok(seen.some(grp => grp[0] === ARTIST && grp.includes(TRACK)));
  assert.deepEqual(packet.tieBreak, { decisive: true, winner: 'THIS', reason: 'DECIDED_BY_NAME_VS_TABLE', decidedBy: 'NAME_VS_TABLE', values: { winner: '1', runnerUp: '0' }, mode: 'compact' });
  const audit = built.audits[ARTIST]!;
  assert.deepEqual([audit.decisive, audit.winner, audit.group[0], audit.decidedBy], [true, ARTIST, ARTIST, 'NAME_VS_TABLE']);
  assert.deepEqual(audit.vectors, { [ARTIST]: { distinctRatio: 1, nameAsymmetry: 'TARGET_NAMED', rangeBias: null } }, 'only scalar traits of group members survive');
  const alone = buildPackets(one.proposals, { minDistinctKeys: 3, tieBreak: () => { throw new Error('boom'); } });
  assert.equal(alone.packets.find(item => item.relationId === ARTIST)!.tieBreak, undefined, 'a resolver that throws leaves the tie standing'); assert.deepEqual(alone.audits, {});
  assert.equal(buildPackets(one.proposals, { minDistinctKeys: 3, tieBreak: () => ({ ordered: ['unknown-id'], decisive: true, reason: 'x' }) }).packets.find(item => item.relationId === ARTIST)!.tieBreak, undefined, 'ids outside the group are refused');
  assert.equal(buildPackets(one.proposals, { minDistinctKeys: 3 }).packets.find(item => item.relationId === ARTIST)!.tieBreak, undefined);
});

test('tie-break: the SIBLING attack of the live ArtistId tie is refuted when orderTies is decisive for the candidate, stays when it is not or favours the sibling', async () => {
  const withTie = (resolver?: TieBreakResolver) => replayRun('two', false, undefined, resolver).then(result => result.run.reviews.find(item => item.relationId === ARTIST)!);
  const none = await withTie();
  assert.equal(none.decision, 'defer'); assert.deepEqual(none.attacksSustained.map(item => item.family), ['SIBLING'], 'the live outcome without any evidence to break the tie');
  const decisive = await withTie(tie(true, [ARTIST, TRACK]));
  assert.equal(decisive.decision, 'accept'); assert.equal(decisive.adversarialPass, 'COMPLETED'); assert.ok(decisive.attacksSurvived.some(item => item.family === 'SIBLING' && item.outcome === 'REFUTED'));
  const undecided = await withTie(tie(false, [ARTIST, TRACK]));
  assert.equal(undecided.decision, 'defer'); assert.deepEqual(undecided.attacksSustained.map(item => item.family), ['SIBLING'], 'a tie that is not decisive stays deferred');
  const wrongWay = await withTie(tie(true, [TRACK, ARTIST]));
  assert.equal(wrongWay.decision, 'defer'); assert.deepEqual(wrongWay.attacksSustained.map(item => item.family), ['SIBLING'], 'decisive for the sibling is not a refutation');
});

test('tie-break: a decisive order does not refute an attack that cites a sibling outside the tie group, and the factory passes the resolver through', async () => {
  const packet = buildPackets(one.proposals, { minDistinctKeys: 3, tieBreak: tie(true, [ARTIST, TRACK]) }).packets.find(item => item.relationId === ARTIST)!;
  const outside = packet.siblings.findIndex(item => item.shares !== 'SOURCE');
  const trackIndex = packet.siblings.findIndex(item => item.relationId === TRACK);
  const attack = (index: number) => ({ family: 'SIBLING' as const, severity: 'blocking' as const, recommend: 'defer' as const, argument: 'x', evidenceRefs: [`siblings[${index}]`] });
  assert.equal(classifyAttacks(packet, [attack(trackIndex)])[0]!.outcome, 'REFUTED');
  if (outside >= 0) assert.equal(classifyAttacks(packet, [attack(outside)])[0]!.outcome, 'SUSTAINED');

  const packetsSeen: ReviewPacket[] = [];
  const spy = new StandInModel('spy', messages => { packetsSeen.push(JSON.parse(messages[1]!.content).packet); return judgeAnswer('SEMANTIC', packetsSeen.at(-1)!); });
  const request = { universeId: 'NWCH', runId: 'r', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', proposals: one.proposals, tableColumns: {}, budget: budget(), now: () => '2026-10-26T00:00:00.000Z' } as unknown as CandidateReviewRequest;
  await createCandidateReview({ judges: [spy], adversary: standInAdversary('adv'), thresholds: { minDistinctKeys: 3 }, tieBreak: tie(true, [ARTIST, TRACK]) })(request);
  assert.ok(packetsSeen.some(item => item.relationId === ARTIST && item.tieBreak?.winner === 'THIS'));
});
