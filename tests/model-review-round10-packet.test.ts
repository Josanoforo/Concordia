import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAttacks } from '../src/agent/model-review/aggregate.ts';
import { reviewBlindCandidates } from '../src/agent/model-review/candidates.ts';
import { deterministicAttacks } from '../src/agent/model-review/deterministic-attacks.ts';
import { buildPackets, reviewEligibility, tieBreakFromOrdering, type ProbedProposalInput, type TieBreakResolver } from '../src/agent/model-review/evidence.ts';
import { confidenceCeiling, evidenceFloor } from '../src/agent/model-review/floors.ts';
import { judgeMessages } from '../src/agent/model-review/prompts.ts';
import { runModelReview } from '../src/agent/model-review/reviewer.ts';
import { attackAnswer, StandInModel, standInAdversary, standInJudge } from '../src/agent/model-review/standin.ts';
import { ONE_TO_ONE_MEANING } from '../src/agent/model-review/types.ts';
import { RunBudget } from '../src/agent/run-budget.ts';
import { orderTies, type TieCandidate } from '../src/agent/tie-break.ts';

/**
 * Round 10, second delivery of phases A/B (X8), from X9's integration: (1) the tie-break vector in the packet is COMPACT by default (the full vector of every sibling cost +56% tokens at
 * the 4M ceiling), the whole one stays on the review record; (2) ONE_TO_ONE_EXTENSION reaches the review as an evidence trait, never a block on its own; (3) a TARGET_CENTRALITY winner
 * is not read as decisive. Offline: stand-ins and X10's real pure functions.
 */
const budget = () => new RunBudget({ maxQueriesPerRun: 5, readLimit: 50, maxTokensPerRun: 5_000_000, maxSteps: 3 });
const probed = (from: [string, string], to: [string, string], over: Partial<ProbedProposalInput> = {}, diagnostic: object = {}): ProbedProposalInput => ({ proposalId: `${from[0]}.${from[1]}__${to[0]}.${to[1]}`, from: { table: from[0], column: from[1] }, to: { table: to[0], column: to[1] },
  coverageProbe: { status: 'EXECUTED', diagnostic: { coverage: { level: 'HIGH', matched: 15, probed: 15, threshold: 0.8 }, multiplicity: { from: { rows: 20, distinctKeys: 15, maxRowsPerKey: 2 }, to: { rows: 15, distinctKeys: 15, maxRowsPerKey: 1 } },
    keyRules: { inclusion: { status: 'NO_VIOLATION_IN_SAMPLE', missingCount: 0 }, targetUniqueness: { status: 'NO_DUPLICATES_IN_SAMPLE' } }, ...diagnostic } }, ...over });
const defaults = { universeId: 'T', database: 'T_DB', normalization: 'text', normalizationVersion: 'text-exact-v1', normalizationAdapterCapability: 'exact-text' };

// ------------------------------------------------------------------ compact tie-break
const SOURCE: [string, string] = ['store_sales', 'ss_item_sk'];
const TARGETS: [string, string][] = [['item', 'i_item_sk'], ['customer', 'c_customer_sk'], ['store', 's_store_sk'], ['promotion', 'p_promo_sk'], ['warehouse', 'w_warehouse_sk'], ['reason', 'r_reason_sk'], ['ship_mode', 'sm_ship_mode_sk'],
  ['web_site', 'web_site_sk'], ['web_page', 'wp_web_page_sk'], ['call_center', 'cc_call_center_sk'], ['income_band', 'ib_income_band_sk'], ['time_dim', 't_time_sk']];
const group12 = () => TARGETS.map(target => probed(SOURCE, target));
const WINNER = 'store_sales.ss_item_sk__item.i_item_sk';
/** X10's real orderTies behind the resolver (whole-table profiles in the candidates), through the adapter the engine would use. */
const realResolver: TieBreakResolver = ids => {
  const candidates: TieCandidate[] = ids.map(id => { const [from, to] = id.split('__') as [string, string], split = (text: string) => ({ table: text.slice(0, text.indexOf('.')), column: text.slice(text.indexOf('.') + 1) });
    return { id, from: split(from), to: split(to), sourceProfile: { provenance: 'GLOBAL_WHOLE_TABLE' as const, rows: 1000, distinct: 900, nulls: 0 }, targetProfile: { provenance: 'GLOBAL_WHOLE_TABLE' as const, rows: 900, distinct: 900, nulls: 0 }, reachesHigh: true }; });
  return tieBreakFromOrdering(orderTies(candidates, { candidates }));
};

test('compact is the default: winner, decisive, deciding step with its two values; the packet grows by a few dozen bytes where the full vector grew it by thousands', () => {
  const none = buildPackets(group12(), { minDistinctKeys: 3 }).packets.find(item => item.relationId === WINNER)!;
  const compact = buildPackets(group12(), { minDistinctKeys: 3, tieBreak: realResolver }), full = buildPackets(group12(), { minDistinctKeys: 3, tieBreak: realResolver, tieBreakMode: 'full' });
  const compactPacket = compact.packets.find(item => item.relationId === WINNER)!, fullPacket = full.packets.find(item => item.relationId === WINNER)!;
  assert.deepEqual([compactPacket.tieBreak!.decisive, compactPacket.tieBreak!.winner, compactPacket.tieBreak!.decidedBy, compactPacket.tieBreak!.mode], [true, 'THIS', 'NAME_VS_TABLE', 'compact']);
  assert.ok(compactPacket.tieBreak!.values && compactPacket.tieBreak!.values.winner !== compactPacket.tieBreak!.values.runnerUp, JSON.stringify(compactPacket.tieBreak));
  assert.equal(compactPacket.tieBreak!.full, undefined); assert.match(compactPacket.tieBreak!.reason, /^DECIDED_BY_NAME_VS_TABLE$/, 'the code, not the sentence');
  const bytes = (packet: object) => JSON.stringify(packet).length, base = bytes(none);
  const compactCost = bytes(compactPacket) - base, fullCost = bytes(fullPacket) - base;
  assert.ok(compactCost < 400, `compact adds ${compactCost} bytes`);
  assert.ok(fullCost > 10 * compactCost, `full adds ${fullCost} bytes, compact ${compactCost}`);
  assert.ok(fullPacket.tieBreak!.full!.group.length === 12 && Object.keys(fullPacket.tieBreak!.full!.vectors ?? {}).length === 12);
  // The loser sees the winner as a listed sibling, by index.
  const loser = compact.packets.find(item => item.relationId.startsWith('store_sales.ss_item_sk__customer.'))!;
  assert.match(loser.tieBreak!.winner!, /^(siblings\[\d+\]|OTHER)$/); assert.equal(loser.tieBreak!.decisive, true);
});

test('the whole tie-break stays on the review record (and in the overlay), never in the prompt; the packet and the audit agree on the winner', async () => {
  const messages = judgeMessages(buildPackets(group12(), { minDistinctKeys: 3, tieBreak: realResolver }).packets.find(item => item.relationId === WINNER)!, 'A');
  assert.doesNotMatch(messages[1]!.content, /distinctRatio|avgLenDiff|rangeBias/, 'no vector in the prompt');
  const result = await reviewBlindCandidates({ proposals: group12(), universeId: 'T', context: { minDistinctKeys: 3, tieBreak: realResolver }, judges: [standInJudge('a', 'SEMANTIC'), standInJudge('b', 'SEMANTIC')], adversary: standInAdversary('adv'), budget: budget(), config: { minDistinctKeys: 3 }, defaults, allowStandIn: true });
  const review = result.overlay.reviews.find(item => item.relationId === WINNER)!;
  assert.equal(review.tieBreak!.decisive, true); assert.equal(review.tieBreak!.winner, WINNER); assert.equal(review.tieBreak!.group.length, 12);
  assert.equal(Object.keys(review.tieBreak!.vectors!).length, 12); assert.ok(review.tieBreak!.detail, 'X10 raw vectors and trace are kept for the audit');
  assert.ok(JSON.stringify((review.tieBreak!.detail as any).trace).includes('NAME_VS_TABLE'));
  assert.equal(review.decision, 'accept', 'the winner of the tie is approved when the SIBLING attack of the stand-in cannot stand');
  assert.deepEqual(review.tieBreak, result.run.reviews.find(item => item.relationId === WINNER)!.tieBreak);
});

test('a non-decisive tie lists the siblings still tied by index; mode full puts the whole order in the prompt', () => {
  const resolver: TieBreakResolver = ids => ({ ordered: [...ids], decisive: false, reason: 'NOT_DECISIVE: tied after every step', siblings: ids.filter(id => /customer|store\./.test(id) || id === WINNER) });
  const packet = buildPackets(group12(), { minDistinctKeys: 3, tieBreak: resolver }).packets.find(item => item.relationId === WINNER)!;
  assert.equal(packet.tieBreak!.decisive, false); assert.equal(packet.tieBreak!.winner, undefined); assert.equal(packet.tieBreak!.reason, 'NOT_DECISIVE');
  assert.ok(packet.tieBreak!.tiedWith!.length >= 1 && packet.tieBreak!.tiedWith!.every(index => packet.siblings[index]!.shares === 'SOURCE' && /customer|store\./.test(packet.siblings[index]!.relationId)));
  assert.equal(packet.siblings.some(sibling => sibling.relationId === WINNER), false, 'the relation itself is never its own sibling');
  const full = buildPackets(group12(), { minDistinctKeys: 3, tieBreak: resolver, tieBreakMode: 'full' }).packets.find(item => item.relationId === WINNER)!;
  assert.match(full.tieBreak!.full!.sentence, /NOT_DECISIVE: tied after every step/); assert.equal(full.tieBreak!.mode, 'full');
});

test('a TARGET_CENTRALITY winner is not decisive: the refutation does not take it, the packet says so and the audit keeps the guard', () => {
  const resolver: TieBreakResolver = ids => ({ ordered: [WINNER, ...ids.filter(id => id !== WINNER)], decisive: true, reason: 'DECIDED_BY_TARGET_CENTRALITY: x', decidedBy: 'TARGET_CENTRALITY',
    trace: [{ step: 'TARGET_CENTRALITY', outcome: 'SEPARATED', values: Object.fromEntries(ids.map(id => [id, id === WINNER ? '9' : '1'])), eliminated: ids.filter(id => id !== WINNER) }] });
  const built = buildPackets(group12(), { minDistinctKeys: 3, tieBreak: resolver }), packet = built.packets.find(item => item.relationId === WINNER)!;
  assert.deepEqual([packet.tieBreak!.decisive, packet.tieBreak!.winner, packet.tieBreak!.reason, packet.tieBreak!.decidedBy], [false, undefined, 'TARGET_CENTRALITY_NOT_DECISIVE', undefined]);
  assert.equal(built.audits[WINNER]!.guard, 'TARGET_CENTRALITY_NOT_DECISIVE'); assert.equal(built.audits[WINNER]!.decisive, false);
  const attack = [{ family: 'SIBLING' as const, severity: 'blocking' as const, recommend: 'defer' as const, argument: 'x', evidenceRefs: ['siblings[0]'] }];
  assert.equal(classifyAttacks(packet, attack)[0]!.outcome, 'SUSTAINED');
  const other = buildPackets(group12(), { minDistinctKeys: 3, tieBreak: ids => ({ ...resolver(ids)!, decidedBy: 'NAME_VS_TABLE', reason: 'DECIDED_BY_NAME_VS_TABLE: y' }) }).packets.find(item => item.relationId === WINNER)!;
  assert.equal(classifyAttacks(other, attack)[0]!.outcome, 'REFUTED', 'the same order decided by a step that is not guarded is taken');
});

// ------------------------------------------------------------------ ONE_TO_ONE_EXTENSION
const O2O = 'catalog_page.cp_end_date_sk__date_dim.d_date_sk';
const oneToOne = (diagnostic: object = {}, over: Partial<ProbedProposalInput> = {}) => probed(['catalog_page', 'cp_end_date_sk'], ['date_dim', 'd_date_sk'], over, diagnostic);
const oneToOneStructure = { from: 'UNIQUE_IN_SAMPLE', to: 'UNIQUE_IN_SAMPLE', rankClass: 'ONE_TO_ONE', targetDeclaredKey: false, orientation: 'AS_PROPOSED', globalUniqueness: { from: 'UNIQUE', to: 'UNIQUE', relationKind: 'EXTENSION_ONE_TO_ONE' } };

test('ONE_TO_ONE_EXTENSION no longer excludes a candidate from the review; any other suspicion still does', () => {
  const suspect = (reasons: string[]) => oneToOne({ suspect: { value: true, reasons } });
  assert.deepEqual(reviewEligibility(suspect(['ONE_TO_ONE_EXTENSION'])), { eligible: true });
  assert.deepEqual(reviewEligibility(oneToOne({}, { structure: oneToOneStructure })), { eligible: true }, 'X4 moved it to a trait: no suspicion at all');
  assert.deepEqual(reviewEligibility(suspect(['ONE_TO_ONE_EXTENSION', 'COMPETING_TARGET'])), { eligible: false, reason: 'SUSPECT:COMPETING_TARGET' });
  assert.deepEqual(reviewEligibility(suspect(['LOW_COVERAGE'])), { eligible: false, reason: 'SUSPECT:LOW_COVERAGE' });
  assert.deepEqual(reviewEligibility(oneToOne({ suspect: { value: true } })), { eligible: false, reason: 'SUSPECT:UNSPECIFIED' });
  assert.equal(reviewEligibility(oneToOne({ coverage: { level: 'LOW', matched: 1, probed: 10 } })).eligible, false);
});

test('the packet carries the 1:1 trait with its explanation, and no suspicion for it', () => {
  for (const proposal of [oneToOne({ suspect: { value: true, reasons: ['ONE_TO_ONE_EXTENSION'] } }), oneToOne({}, { structure: oneToOneStructure })]) {
    const packet = buildPackets([proposal], { minDistinctKeys: 3 }).packets[0]!;
    assert.deepEqual(packet.oneToOne, { globalUniqueness: { source: 'UNIQUE', target: 'UNIQUE' }, meaning: ONE_TO_ONE_MEANING });
    assert.equal(packet.suspect, undefined, 'the trait is not a suspicion');
  }
  const plain = buildPackets([probed(['catalog_page', 'cp_end_date_sk'], ['date_dim', 'd_date_sk'])], { minDistinctKeys: 3 }).packets[0]!;
  assert.equal(plain.oneToOne, undefined);
  const mixed = buildPackets([oneToOne({ suspect: { value: true, reasons: ['ONE_TO_ONE_EXTENSION', 'LABEL_UNCERTAIN'] } })], { minDistinctKeys: 3 }).packets[0]!;
  assert.deepEqual(mixed.suspect!.reasons, ['LABEL_UNCERTAIN'], 'only the real suspicions are listed as suspicion');
  assert.match(ONE_TO_ONE_MEANING, /one-to-one extension/); assert.match(ONE_TO_ONE_MEANING, /happens to be unique/); assert.match(ONE_TO_ONE_MEANING, /Not a reason to reject on its own/);
  const prompt = judgeMessages(buildPackets([oneToOne({}, { structure: oneToOneStructure })], { minDistinctKeys: 3 }).packets[0]!, 'A');
  assert.match(prompt[0]!.content, /oneToOne, when present/); assert.match(prompt[1]!.content, /may be a one-to-one extension/);
});

test('the 1:1 trait lowers the confidence ceiling and is a minor orientation weakness; it is never blocking on its own', () => {
  const packet = buildPackets([oneToOne({}, { structure: oneToOneStructure })], { minDistinctKeys: 3 }).packets[0]!;
  const floor = evidenceFloor(packet);
  assert.equal(floor.cap, 'accept'); assert.deepEqual(floor.annotations, ['ONE_TO_ONE_EXTENSION']); assert.equal(confidenceCeiling(floor), 'medium');
  const [, orientation] = deterministicAttacks(packet);
  assert.deepEqual([orientation!.family, orientation!.severity, orientation!.outcome, orientation!.evidenceRefs], ['INVERTED_ORIENTATION', 'minor', 'SURVIVED', ['oneToOne']]);
  const attack = (refs: string[]) => ({ family: 'HOMONYM' as const, severity: 'blocking' as const, recommend: 'reject' as const, argument: 'both unique, so a 1:1 copy', evidenceRefs: refs });
  assert.equal(classifyAttacks(packet, [attack(['oneToOne'])])[0]!.outcome, 'SURVIVED', 'citing only the trait cannot block');
  assert.equal(classifyAttacks(packet, [attack(['oneToOne.globalUniqueness'])])[0]!.outcome, 'SURVIVED');
  assert.equal(classifyAttacks(packet, [attack(['oneToOne', 'target.table'])])[0]!.outcome, 'SUSTAINED', 'with other evidence an attack is judged on its merits');
  assert.equal(classifyAttacks(packet, [attack(['oneToOne.bogus'])])[0]!.outcome, 'UNGROUNDED');
});

test('end to end: a 1:1 candidate is reviewed, accepted by name and evidence, survives an adversary that argues only the trait, and gets a MODEL_REVIEWED contract with medium confidence at most', async () => {
  const proposal = oneToOne({ suspect: { value: true, reasons: ['ONE_TO_ONE_EXTENSION'] } }, { structure: oneToOneStructure });
  const adversary = new StandInModel('adv', messages => { const packet = JSON.parse(messages[1]!.content).packet;
    return JSON.stringify({ relationId: packet.relationId, attacks: [{ family: 'HOMONYM', severity: 'blocking', recommend: 'reject', argument: 'both ends are unique: a 1:1 copy', evidenceRefs: ['oneToOne'] }, { family: 'SIBLING', severity: 'none', recommend: 'keep', argument: '', evidenceRefs: [] }] }); });
  const result = await reviewBlindCandidates({ proposals: [proposal], universeId: 'T', context: { minDistinctKeys: 3 }, judges: [standInJudge('a', 'SEMANTIC'), standInJudge('b', 'SEMANTIC')], adversary, budget: budget(), config: { minDistinctKeys: 3 }, defaults, allowStandIn: true });
  const review = result.run.reviews[0]!;
  assert.equal(result.run.counts.relations, 1); assert.equal(review.decision, 'accept'); assert.equal(review.adversarialPass, 'COMPLETED');
  assert.ok(review.attacksSurvived.some(attack => attack.family === 'HOMONYM' && attack.outcome === 'SURVIVED'));
  assert.ok(review.reasons.includes('ONE_TO_ONE_EXTENSION')); assert.notEqual(review.confidence, 'high');
  assert.equal(result.contracts.length, 1); assert.equal(result.contracts[0]!.reviewOrigin, 'MODEL_REVIEWED'); assert.equal(result.overlay.notApproved.length, 0);
  // The same attack with a real reference still blocks: the trait is not a shield.
  const blocking = new StandInModel('adv2', messages => JSON.stringify({ relationId: JSON.parse(messages[1]!.content).packet.relationId, attacks: [{ family: 'HOMONYM', severity: 'blocking', recommend: 'defer', argument: 'other entity', evidenceRefs: ['oneToOne', 'target.table'] }, { family: 'SIBLING', severity: 'none', recommend: 'keep', argument: '', evidenceRefs: [] }] }));
  const stopped = await runModelReview({ packets: buildPackets([proposal], { minDistinctKeys: 3 }).packets, judges: [standInJudge('a', 'SEMANTIC'), standInJudge('b', 'SEMANTIC')], adversary: blocking, budget: budget(), config: { minDistinctKeys: 3 } });
  assert.equal(stopped.reviews[0]!.decision, 'defer');
  assert.ok(attackAnswer(buildPackets([proposal], { minDistinctKeys: 3 }).packets[0]!).includes('"SIBLING"'));
});
