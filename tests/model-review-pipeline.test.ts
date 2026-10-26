import test from 'node:test';
import assert from 'node:assert/strict';
import { runModelReview, estimateModelReviewCost } from '../src/agent/model-review/reviewer.ts';
import { StandInModel, standInAdversary, standInJudge } from '../src/agent/model-review/standin.ts';
import { MODEL_REVIEW_LABEL, MODEL_REVIEW_LABEL_NO_ADVERSARIAL, MODEL_REVIEWED, satisfiesModelAdversarialSlot, type ModelReview, type ReviewPacket, type ReviewTraceEvent } from '../src/agent/model-review/types.ts';
import { evidenceFloor } from '../src/agent/model-review/floors.ts';
import { aggregateReview } from '../src/agent/model-review/aggregate.ts';
import { proposedContract } from '../src/agent/model-review/contract.ts';
import { RunBudget } from '../src/agent/run-budget.ts';

const budgetWith = (maxTokensPerRun: number) => new RunBudget({ maxQueriesPerRun: 10, readLimit: 50, maxTokensPerRun, maxSteps: 3 });
const packet = (over: Partial<ReviewPacket> & { relationId?: string; source?: ReviewPacket['source']; target?: ReviewPacket['target'] } = {}): ReviewPacket => ({
  relationId: 'store_returns.sr_customer_sk__customer.c_customer_sk', source: { table: 'store_returns', column: 'sr_customer_sk' }, target: { table: 'customer', column: 'c_customer_sk' },
  orientation: 'AS_PROPOSED', coverage: { level: 'HIGH', matched: 19, probed: 19, threshold: 0.8 }, sourceKeys: { rows: 20, distinctKeys: 19, maxRowsPerKey: 2 }, targetKeys: { rows: 19, distinctKeys: 19, maxRowsPerKey: 1 },
  keyRules: { inclusion: 'NO_VIOLATION_IN_SAMPLE', missingCount: 0, targetUniqueness: 'NO_DUPLICATES_IN_SAMPLE', duplicateKeyCount: 0 }, labels: { signal: 'NOT_COMPARABLE' },
  minDistinctKeys: 3, siblings: [], negativeControl: [], limitations: ['bounded sample'], ...over
});
const homonym = () => packet({ relationId: 'store_sales.ss_store_sk__web_site.web_site_sk', source: { table: 'store_sales', column: 'ss_store_sk' }, target: { table: 'web_site', column: 'web_site_sk' },
  coverage: { level: 'HIGH', matched: 3, probed: 3, threshold: 0.8 }, sourceKeys: { rows: 3, distinctKeys: 3, maxRowsPerKey: 1 }, targetKeys: { rows: 3, distinctKeys: 3, maxRowsPerKey: 1 },
  siblings: [{ relationId: 'store_sales.ss_store_sk__store.s_store_sk', shares: 'SOURCE', other: { table: 'store', column: 's_store_sk' }, executed: true, coverage: { matched: 3, probed: 3 } }] });
const run = (packets: ReviewPacket[], judges = [standInJudge('j1', 'SEMANTIC'), standInJudge('j2', 'SEMANTIC')], adversary = standInAdversary('adv'), budget = budgetWith(500_000), config = {}) =>
  runModelReview({ packets, judges, adversary, budget, config: { minDistinctKeys: 3, ...config } });

test('a name-and-evidence agreement is accepted, sealed MODEL_REVIEWED and labelled with the completed adversarial pass', async () => {
  const result = await run([packet()]);
  const review = result.reviews[0]!;
  assert.equal(review.decision, 'accept');
  assert.equal(review.origin, MODEL_REVIEWED); assert.equal(review.humanReviewed, false); assert.equal(review.boundedSampleOnly, true);
  assert.equal(review.adversarialPass, 'COMPLETED'); assert.equal(review.label, MODEL_REVIEW_LABEL);
  assert.equal(review.attacksSustained.length, 0);
  assert.equal(review.evaluations.length, 2); assert.equal(review.adversary.attacks.length, 4);
  assert.equal(result.origin, MODEL_REVIEWED); assert.equal(result.counts.accept, 1);
});

test('the adversarial pass catches the homonym that evidence-only judges accept; without it the homonym is accepted', async () => {
  const evidenceOnly = [standInJudge('e1', 'EVIDENCE_ONLY'), standInJudge('e2', 'EVIDENCE_ONLY')];
  const without = (await run([homonym()], evidenceOnly, standInAdversary('adv'), budgetWith(500_000), { attackScope: 'NONE' })).reviews[0]!;
  assert.equal(without.decision, 'accept', 'bounded key membership alone cannot tell the homonym apart (the live negative control)');
  assert.equal(without.adversarialPass, 'NOT_RUN'); assert.equal(without.label, MODEL_REVIEW_LABEL_NO_ADVERSARIAL);
  assert.equal(satisfiesModelAdversarialSlot(without), false);
  const withPass = (await run([homonym()], [standInJudge('e1', 'EVIDENCE_ONLY'), standInJudge('e2', 'EVIDENCE_ONLY')])).reviews[0]!;
  assert.equal(withPass.decision, 'reject');
  assert.equal(withPass.adversarialPass, 'COMPLETED');
  const families = withPass.attacksSustained.map(attack => attack.family).sort();
  assert.deepEqual(families, ['HOMONYM', 'SIBLING']);
  assert.ok(withPass.reasons.includes('HOMONYM_RISK') && withPass.reasons.includes('SIBLING_BETTER_MATCH'));
});

test('attacks that were raised and did not lower the decision are recorded as survived', async () => {
  const atMinimum = packet({ sourceKeys: { rows: 20, distinctKeys: 3, maxRowsPerKey: 7 }, coverage: { level: 'HIGH', matched: 3, probed: 3, threshold: 0.8 } });
  const review = (await run([atMinimum])).reviews[0]!;
  assert.equal(review.decision, 'accept');
  assert.equal(review.confidence, 'medium', 'at the minimum the name decides: no high confidence');
  assert.ok(review.reasons.includes('AT_MINIMUM_KEYS'));
  assert.deepEqual(review.attacksSurvived.map(attack => attack.family), ['INSUFFICIENT_KEYS']);
});

test('the evidence floor caps what any judge says: too few keys never accepted, missing keys rejected without a model call', async () => {
  const oneKey = packet({ sourceKeys: { rows: 20, distinctKeys: 1, maxRowsPerKey: 20 }, coverage: { level: 'HIGH', matched: 1, probed: 1, threshold: 0.8 } });
  const missing = packet({ relationId: 'x', coverage: { level: 'LOW', matched: 1, probed: 19, threshold: 0.8 }, keyRules: { inclusion: 'VIOLATION_OBSERVED', missingCount: 18, targetUniqueness: 'NO_DUPLICATES_IN_SAMPLE', duplicateKeyCount: 0 } });
  const duplicated = packet({ relationId: 'y', keyRules: { inclusion: 'NO_VIOLATION_IN_SAMPLE', missingCount: 0, targetUniqueness: 'DUPLICATES_OBSERVED', duplicateKeyCount: 1 } });
  const judge = standInJudge('always', 'EVIDENCE_ONLY'), liar = new StandInModel('liar', messages => JSON.stringify({ relationId: JSON.parse(messages[1]!.content).packet.relationId, decision: 'accept', confidence: 'high', reasonCodes: ['NAME_ENTITY_MATCH'], rationale: 'fine' }));
  const result = await run([oneKey, missing, duplicated], [liar, liar], standInAdversary('adv'));
  const byId = new Map(result.reviews.map(review => [review.relationId, review]));
  assert.equal(byId.get(oneKey.relationId)!.decision, 'defer');
  assert.ok(byId.get(oneKey.relationId)!.reasons.includes('INSUFFICIENT_DISTINCT_KEYS'));
  assert.equal(byId.get('x')!.decision, 'reject'); assert.equal(byId.get('x')!.calls, 0, 'the evidence already rejects: no generation spent');
  assert.equal(byId.get('x')!.confidence, 'high');
  assert.equal(byId.get('y')!.decision, 'defer'); assert.ok(byId.get('y')!.reasons.includes('TARGET_NOT_UNIQUE'));
  assert.equal(judge.calls, 0);
  assert.equal(evidenceFloor(oneKey).cap, 'defer');
});

test('judges that disagree defer; an accept that cites a blocking reason is read as defer; failures count as defer', async () => {
  const reply = (decision: string, codes: string[]) => (m: readonly { content: string }[]) => JSON.stringify({ relationId: JSON.parse(m[1]!.content).packet.relationId, decision, confidence: 'high', reasonCodes: codes, rationale: 'r' });
  const split = (await run([packet()], [new StandInModel('a', reply('accept', ['NAME_ENTITY_MATCH'])), new StandInModel('b', reply('defer', ['NAME_AMBIGUOUS']))])).reviews[0]!;
  assert.equal(split.decision, 'defer'); assert.equal(split.confidence, 'low'); assert.equal(split.adversary.status, 'COMPLETED');
  const contradictory = (await run([packet()], [new StandInModel('a', reply('accept', ['NAME_ENTITY_MATCH', 'HOMONYM_RISK']))])).reviews[0]!;
  assert.equal(contradictory.decision, 'defer'); assert.equal(contradictory.evaluations[0]!.status, 'INVALID', 'an accept that cites a blocking code is refused by the parser, not repaired');
  // Defensive guard in the aggregation, for an evaluation that reached it by another route.
  const forged = aggregateReview({ packet: packet(), floor: evidenceFloor(packet()), judgesConfigured: 1, attackScope: 'ACCEPTED_ONLY', provenance: 'LIVE_MODEL', calls: 0, tokens: 0, adversary: { actor: 'a', status: 'NOT_NEEDED', attacks: [] },
    evaluations: [{ judgeId: 'j', status: 'VALID', decision: 'accept', confidence: 'high', reasonCodes: ['NAME_ENTITY_MATCH', 'SIBLING_BETTER_MATCH'], flags: [] }] });
  assert.equal(forged.decision, 'defer'); assert.ok(forged.evaluations[0]!.flags.includes('ACCEPT_WITH_BLOCKING_REASON'));
  const broken = (await run([packet()], [standInJudge('ok', 'SEMANTIC'), new StandInModel('bad', () => 'not json')])).reviews[0]!;
  assert.equal(broken.decision, 'defer'); assert.deepEqual(broken.evaluations.map(e => e.status), ['VALID', 'INVALID']);
  const failing = (await run([packet()], [standInJudge('ok', 'SEMANTIC'), new StandInModel('down', () => ({ status: 'FAIL', error: { code: 'X' } }))])).reviews[0]!;
  assert.equal(failing.decision, 'defer'); assert.deepEqual(failing.evaluations.map(e => e.status), ['VALID', 'CALL_FAILED']);
});

test('an accept needs the adversarial pass: a failed, invalid or budget-skipped adversary defers it', async () => {
  for (const adversary of [new StandInModel('down', () => ({ status: 'FAIL', error: { code: 'X' } })), new StandInModel('junk', () => '{"attacks":[]}')]) {
    const review = (await run([packet()], undefined, adversary)).reviews[0]!;
    assert.equal(review.decision, 'defer'); assert.equal(review.adversarialPass, 'INCOMPLETE'); assert.equal(review.label, MODEL_REVIEW_LABEL_NO_ADVERSARIAL);
    assert.equal(satisfiesModelAdversarialSlot(review), false);
  }
});

test('a blocking attack that cites evidence not in the packet is discarded as ungrounded and the decision stands', async () => {
  const fabricated = new StandInModel('adv', messages => JSON.stringify({ relationId: JSON.parse(messages[1]!.content).packet.relationId, attacks: [
    { family: 'HOMONYM', severity: 'blocking', recommend: 'reject', argument: 'looks like another entity', evidenceRefs: ['target.sampleValues'] },
    { family: 'INSUFFICIENT_KEYS', severity: 'blocking', recommend: 'reject', argument: 'the model argues a computed family: ignored', evidenceRefs: ['sourceKeys'] },
    { family: 'SIBLING', severity: 'none', recommend: 'keep', argument: '-', evidenceRefs: [] }, { family: 'INVERTED_ORIENTATION', severity: 'none', recommend: 'keep', argument: '-', evidenceRefs: [] }] }));
  const review = (await run([packet()], undefined, fabricated)).reviews[0]!;
  assert.equal(review.decision, 'accept');
  assert.deepEqual(review.adversary.attacks.map(attack => attack.outcome), ['UNGROUNDED', 'NO_ATTACK', 'NO_ATTACK', 'NO_ATTACK']);
  assert.deepEqual(review.adversary.attacks.map(attack => attack.source), ['MODEL', 'DETERMINISTIC', 'MODEL', 'DETERMINISTIC'], 'the computed families come from the packet, never from the model');
  assert.equal(review.attacksSustained.length, 0);
});

test('a grounded blocking attack from any adversary lowers the decision, and only lowers it', async () => {
  const sustained = new StandInModel('adv', messages => JSON.stringify({ relationId: JSON.parse(messages[1]!.content).packet.relationId, attacks: [
    { family: 'HOMONYM', severity: 'blocking', recommend: 'defer', argument: 'overlapping small domains', evidenceRefs: ['coverage', 'target.table'] },
    { family: 'INSUFFICIENT_KEYS', severity: 'none', recommend: 'keep', argument: '-', evidenceRefs: [] }, { family: 'SIBLING', severity: 'none', recommend: 'keep', argument: '-', evidenceRefs: [] }, { family: 'INVERTED_ORIENTATION', severity: 'none', recommend: 'keep', argument: '-', evidenceRefs: [] }] }));
  const lowered = (await run([packet()], undefined, sustained)).reviews[0]!;
  assert.equal(lowered.decision, 'defer'); assert.equal(lowered.attacksSustained[0]!.family, 'HOMONYM');
  // Judges reject, adversary says everything is fine: the review stays reject (an attack pass never raises).
  const rejecting = new StandInModel('r', messages => JSON.stringify({ relationId: JSON.parse(messages[1]!.content).packet.relationId, decision: 'reject', confidence: 'high', reasonCodes: ['NAME_ENTITY_MISMATCH'], rationale: 'r' }));
  const stays = (await run([packet()], [rejecting, rejecting], standInAdversary('adv'), budgetWith(500_000), { attackScope: 'ALL' })).reviews[0]!;
  assert.equal(stays.decision, 'reject');
});

test('every generation is counted: budget charged from receipts, trace has prompt hash, raw response and tokens, never the prompt text', async () => {
  const events: ReviewTraceEvent[] = [];
  const budget = budgetWith(500_000);
  const result = await runModelReview({ packets: [packet(), homonym()], judges: [standInJudge('j1', 'SEMANTIC'), standInJudge('j2', 'EVIDENCE_ONLY')], adversary: standInAdversary('adv'), budget, config: { minDistinctKeys: 3 }, onEvent: event => events.push(event) });
  const calls = result.trace.filter(event => event.kind === 'model-review-call');
  assert.equal(calls.length, result.counts.calls);
  assert.equal(budget.tokens, calls.reduce((sum, event) => sum + (event.tokens ?? 0), 0));
  assert.equal(result.counts.tokens, budget.tokens);
  assert.deepEqual(events, result.trace, 'onEvent receives exactly the events returned');
  for (const event of calls) {
    assert.match(event.promptHash!, /^[0-9a-f]{64}$/); assert.ok(event.responseText && event.responseText.length > 0); assert.ok((event.tokens ?? 0) > 0); assert.ok(event.receipt);
    assert.equal(event.responseText!.includes('data-modelling reviewer'), false);
  }
  assert.ok(calls.some(event => event.stage === 'ATTACK') && calls.some(event => event.stage === 'EVALUATION'));
  assert.ok(result.trace.filter(event => event.kind === 'model-review-decision').length === 2);
  const hashes = new Set(calls.map(event => event.promptHash)); assert.equal(hashes.size, calls.length, 'distinct prompts have distinct hashes');
});

test('when the token budget does not fit, calls are skipped and recorded, relations are deferred, and nothing is dropped silently', async () => {
  const packets = [packet({ relationId: 'a' }), packet({ relationId: 'b' }), packet({ relationId: 'c' })];
  const estimate = estimateModelReviewCost(packets, 2, { attackScope: 'ACCEPTED_ONLY' });
  const tiny = budgetWith(Math.floor(estimate.estimatedTokens / 3));
  const result = await runModelReview({ packets, judges: [standInJudge('j1', 'SEMANTIC'), standInJudge('j2', 'SEMANTIC')], adversary: standInAdversary('adv'), budget: tiny, config: { minDistinctKeys: 3 } });
  assert.equal(result.status, 'PARTIAL_BUDGET'); assert.equal(result.reviews.length, 3);
  assert.ok(result.counts.skippedBudget > 0);
  assert.ok(tiny.tokens <= tiny.limits.maxTokensPerRun);
  assert.ok(result.trace.some(event => event.callStatus === 'SKIPPED_BUDGET'));
  assert.ok(result.reviews.some(review => review.decision === 'defer' && review.evaluations.some(e => e.status === 'SKIPPED_BUDGET')));
  assert.ok(result.reviews.every(review => review.decision !== 'accept' || review.adversarialPass === 'COMPLETED'));
});

test('the pre-estimate is an upper bound of what the run then spends', async () => {
  const packets = [packet({ relationId: 'a' }), homonym(), packet({ relationId: 'z', coverage: { level: 'LOW', matched: 1, probed: 5, threshold: 0.8 }, keyRules: { inclusion: 'VIOLATION_OBSERVED', missingCount: 4, targetUniqueness: 'NO_DUPLICATES_IN_SAMPLE', duplicateKeyCount: 0 } })];
  const estimate = estimateModelReviewCost(packets, 2, { attackScope: 'ACCEPTED_ONLY' });
  const result = await run(packets);
  assert.ok(estimate.estimatedTokens >= result.counts.tokens, `${estimate.estimatedTokens} >= ${result.counts.tokens}`);
  assert.ok(estimate.calls >= result.counts.calls);
  assert.equal(estimate.relations, 3); assert.equal(estimate.evaluatedRelations, 2);
});

test('a stand-in run is marked STAND_IN_OFFLINE and can never fill a MODEL_ADVERSARIAL slot or produce a live contract', async () => {
  const result = await run([packet()]);
  const review = result.reviews[0]!;
  assert.equal(result.provenance, 'STAND_IN_OFFLINE'); assert.equal(review.provenance, 'STAND_IN_OFFLINE');
  assert.ok(result.limitations.some(item => item.includes('STAND_IN_OFFLINE')));
  assert.equal(satisfiesModelAdversarialSlot(review), false);
  const defaults = { universeId: 'TPCDS', database: 'TPCDS_DB', normalization: 'text', normalizationVersion: 'text-exact-v1', normalizationAdapterCapability: 'exact-text' };
  assert.equal(proposedContract(review, defaults), undefined);
  const offline = proposedContract(review, defaults, { allowStandIn: true })!;
  assert.equal(offline.reviewOrigin, MODEL_REVIEWED); assert.equal(offline.reviewState, 'REVIEWED'); assert.equal(offline.identifierSpace, 'tpcds-customer-c_customer_sk-v1');
  // A live-provenance accept with a completed pass does satisfy the slot (the type contract X5 uses).
  const live: ModelReview = { ...review, provenance: 'LIVE_MODEL' };
  assert.equal(satisfiesModelAdversarialSlot(live), true);
  assert.equal(proposedContract({ ...live, decision: 'defer' }, defaults), undefined);
  assert.equal(satisfiesModelAdversarialSlot({ ...live, adversarialPass: 'INCOMPLETE' }), false);
});

test('honest labeling: module-authored labels say "revisado por modelo", never "validated"', async () => {
  const result = await run([packet(), homonym()]);
  const texts = [result.label, MODEL_REVIEW_LABEL, MODEL_REVIEW_LABEL_NO_ADVERSARIAL, ...result.reviews.map(review => review.label), ...result.reviews.flatMap(review => review.notes), ...result.limitations];
  for (const text of texts) assert.doesNotMatch(text, /validad|validated/i);
  assert.equal(MODEL_REVIEW_LABEL, 'revisado por modelo con pase adversarial');
  for (const review of result.reviews) { assert.equal(review.origin, 'MODEL_REVIEWED'); assert.notEqual(review.origin as string, 'HUMAN_REVIEWED'); }
});

test('invalid configuration fails closed', async () => {
  await assert.rejects(() => runModelReview({ packets: [packet()], judges: [], adversary: standInAdversary('a'), budget: budgetWith(1e6), config: { minDistinctKeys: 3 } }), /JUDGES_OUT_OF_RANGE/);
  await assert.rejects(() => runModelReview({ packets: [packet()], judges: [standInJudge('a', 'SEMANTIC')], adversary: standInAdversary('a'), budget: budgetWith(1e6), config: { minDistinctKeys: 0 } }), /MIN_DISTINCT_KEYS/);
  const empty = await run([]);
  assert.equal(empty.status, 'EMPTY'); assert.equal(empty.counts.calls, 0);
});
