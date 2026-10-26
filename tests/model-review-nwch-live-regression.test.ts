import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { reviewBlindCandidates } from '../src/agent/model-review/candidates.ts';
import { adversaryMessages, judgeMessages, parseAttacks, parseEvaluation, OUTPUT_RULE } from '../src/agent/model-review/prompts.ts';
import { standInAdversary, StandInModel } from '../src/agent/model-review/standin.ts';
import { BLOCKING_REASON_CODES, REASON_CODES, type ModelMessage, type ReviewModel } from '../src/agent/model-review/types.ts';
import { RunBudget } from '../src/agent/run-budget.ts';

/**
 * Regression with the REAL model responses of the live NWCH blind run (agent-nwch-r9-blind-live-01), sanitized (no receipt or request ids). That run judged correctly 11 of 11 yet
 * approved nothing, for two defects in this module: (1) a 400-token output cap truncated 5 of 11 judge answers and every adversary answer (the model writes prose or long JSON),
 * and (2) the judges used SIBLING_BETTER_MATCH inside an accept to say "this one beats its siblings", which the aggregation reads as blocking.
 * Nothing here is live: the fixture replays recorded text.
 */
interface Recorded { relationId: string; stage: 'EVALUATION' | 'ATTACK'; slot: number; actor: string; outputTokens: number; responseText: string }
const fixture = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'model-review', 'nwch-live-01.json'), 'utf8')) as { proposals: any[]; responses: Recorded[] };
const FK = ['chinook_album.ArtistId__chinook_artist.ArtistId', 'northwind_order_details.OrderID__northwind_orders.OrderID', 'northwind_order_details.ProductID__northwind_products.ProductID'];
const ORPHANS_AND_HOMONYMS = ['chinook_playlist_track.PlaylistId__chinook_artist.ArtistId', 'chinook_album.AlbumId__chinook_playlist_track.TrackId', 'chinook_album.ArtistId__chinook_playlist_track.TrackId', 'chinook_artist.ArtistId__chinook_playlist_track.TrackId', 'chinook_playlist_track.PlaylistId__chinook_album.AlbumId'];
const defaults = { universeId: 'NWCH', database: 'NWCH_DB', normalization: 'text', normalizationVersion: 'text-exact-v1', normalizationAdapterCapability: 'exact-text' };

const relationOf = (messages: readonly ModelMessage[]) => JSON.parse(messages[1]!.content).packet.relationId as string;
/** Replays what the live model answered for (relation, stage, judge slot). A call that was never made live has no recording and fails. */
function replay(id: string, stage: 'EVALUATION' | 'ATTACK', slot: number, transform: (text: string, record: Recorded) => string = text => text, seen: { maxOutputTokens: number[] } = { maxOutputTokens: [] }) {
  const model = new StandInModel(id, messages => {
    const record = fixture.responses.find(item => item.relationId === relationOf(messages) && item.stage === stage && item.slot === slot);
    return record ? { status: 'PASS', responseText: transform(record.responseText, record), receipt: { receiptId: 'replay', provider: 'replay', model: 'replay', inputTokens: 1000, outputTokens: record.outputTokens, totalTokens: 1000 + record.outputTokens, latencyMs: 0, fromCache: false }, truncated: record.outputTokens >= 400 } : { status: 'FAIL', error: { code: 'NOT_RECORDED' } };
  });
  const complete = model.complete.bind(model);
  model.complete = async (messages, options) => { seen.maxOutputTokens.push(options.maxOutputTokens); return complete(messages, options); };
  return Object.assign(model, { kind: 'LIVE_MODEL' as const }) as ReviewModel;
}
/** The legacy accepts that cited SIBLING_BETTER_MATCH meant "my siblings are weaker" (their rationale says so); the fixed vocabulary has a code for that meaning. */
const migrateLegacySiblingCode = (text: string) => { try { const value = JSON.parse(text); return value.decision === 'accept' ? JSON.stringify({ ...value, reasonCodes: value.reasonCodes.map((code: string) => code === 'SIBLING_BETTER_MATCH' ? 'SIBLINGS_WEAKER' : code) }) : text; } catch { return text; } };

const run = (judges: ReviewModel[], adversary: ReviewModel) => reviewBlindCandidates({ proposals: fixture.proposals, universeId: 'NWCH', context: { minDistinctKeys: 3 }, judges, adversary,
  budget: new RunBudget({ maxQueriesPerRun: 5, readLimit: 50, maxTokensPerRun: 1_000_000, maxSteps: 3 }), config: { minDistinctKeys: 3 }, defaults });

test('the fixture is the live run: 30 candidates, 8 reach a model, 19 recorded answers, 7 of them cut at 400 output tokens, no ids', () => {
  assert.equal(fixture.proposals.length, 30); assert.equal(fixture.responses.length, 19);
  assert.equal(fixture.responses.filter(item => item.outputTokens === 400).length, 7, '4 judge answers + 3 adversary answers hit the cap');
  assert.equal(fixture.responses.filter(item => item.stage === 'ATTACK').every(item => item.outputTokens === 400), true);
  assert.equal(/rcpt_|req_|requestId|queryId/.test(JSON.stringify(fixture)), false);
});

test('defect 1: the recorded truncated answers do not parse and are never repaired or retried; the verbatim replay still approves nothing (as live)', async () => {
  for (const record of fixture.responses.filter(item => item.outputTokens === 400)) {
    if (record.stage === 'EVALUATION') assert.equal(parseEvaluation(record.responseText, record.relationId), undefined, record.relationId);
    else assert.equal(parseAttacks(record.responseText, record.relationId), undefined, record.relationId);
  }
  const judgeA = replay('judge-a', 'EVALUATION', 0), judgeB = replay('judge-b', 'EVALUATION', 1), adversary = replay('adversary', 'ATTACK', 0);
  const result = await run([judgeA, judgeB], adversary);
  assert.equal(result.contracts.length, 0, 'verbatim: nothing is approved, exactly as the live run');
  assert.equal(result.run.counts.calls, 16, '8 relations x 2 judges: no accept survives the parser, so no adversary call, and no retry on an invalid or truncated answer');
  assert.ok(result.run.reviews.every(review => review.decision !== 'accept'));
});

test('defect 1 fix: judges are asked for up to 1500 output tokens and the adversary for 3000 (the client caps at 3000), and the prompts demand one JSON object with no reasoning', async () => {
  const judgeSeen = { maxOutputTokens: [] as number[] }, attackSeen = { maxOutputTokens: [] as number[] };
  await run([replay('judge-a', 'EVALUATION', 0, migrateLegacySiblingCode, judgeSeen), replay('judge-b', 'EVALUATION', 1, migrateLegacySiblingCode, judgeSeen)], replay('adversary', 'ATTACK', 0, undefined, attackSeen));
  assert.ok(judgeSeen.maxOutputTokens.length > 0 && judgeSeen.maxOutputTokens.every(value => value === 1500));
  assert.ok(attackSeen.maxOutputTokens.length > 0 && attackSeen.maxOutputTokens.every(value => value === 3000));
  const proposal = fixture.proposals[0];
  const packet = { relationId: proposal.proposalId } as any;
  for (const messages of [judgeMessages(packet, 'A'), adversaryMessages(packet, [])]) {
    assert.ok(messages[0]!.content.includes(OUTPUT_RULE)); assert.match(OUTPUT_RULE, /exactly ONE JSON object/); assert.match(OUTPUT_RULE, /no reasoning/);
  }
});

test('defect 2: SIBLINGS_WEAKER supports an accept, SIBLING_BETTER_MATCH blocks it, and an accept citing a blocking code is refused by the parser', () => {
  assert.ok((REASON_CODES as readonly string[]).includes('SIBLINGS_WEAKER'));
  assert.equal(BLOCKING_REASON_CODES.includes('SIBLINGS_WEAKER' as any), false);
  assert.ok(BLOCKING_REASON_CODES.includes('SIBLING_BETTER_MATCH'));
  const accept = (codes: string[]) => JSON.stringify({ relationId: 'r', decision: 'accept', confidence: 'high', reasonCodes: codes, rationale: 'x' });
  assert.ok(parseEvaluation(accept(['NAME_ENTITY_MATCH', 'SIBLINGS_WEAKER']), 'r'));
  assert.equal(parseEvaluation(accept(['NAME_ENTITY_MATCH', 'SIBLING_BETTER_MATCH']), 'r'), undefined);
  const guide = JSON.parse(judgeMessages({ relationId: 'r' } as any, 'A')[1]!.content).reasonCodes;
  assert.match(guide.SIBLINGS_WEAKER, /SUPPORTS accept/); assert.match(guide.SIBLING_BETTER_MATCH, /BLOCKS accept/);
  // The real accepts of the live run used the blocking code: under the fixed vocabulary they are refused, which is why the prompt now defines both.
  const legacyAccepts = fixture.responses.filter(item => item.stage === 'EVALUATION' && item.outputTokens < 400 && /"decision":"accept"/.test(item.responseText) && item.responseText.includes('SIBLING_BETTER_MATCH'));
  assert.equal(legacyAccepts.length, 5);
  for (const record of legacyAccepts) { assert.equal(parseEvaluation(record.responseText, record.relationId), undefined); assert.ok(parseEvaluation(migrateLegacySiblingCode(record.responseText), record.relationId), record.relationId); }
});

test('with both fixes, the real judge answers give accept on the FKs whose judges both answered, and the homonyms and orphans stay reject or defer', async () => {
  const judges = [replay('judge-a', 'EVALUATION', 0, migrateLegacySiblingCode), replay('judge-b', 'EVALUATION', 1, migrateLegacySiblingCode)];
  // The recorded adversary answers are all cut, so the adversarial pass is the offline one: this part of the replay is a stand-in and is labelled so.
  const result = await run(judges, Object.assign(standInAdversary('standin-adversary'), { kind: 'LIVE_MODEL' as const }) as ReviewModel);
  const byId = new Map(result.run.reviews.map(review => [review.relationId, review]));
  const accepted = result.run.reviews.filter(review => review.decision === 'accept').map(review => review.relationId).sort();
  assert.deepEqual(accepted, ['northwind_order_details.OrderID__northwind_orders.OrderID', 'northwind_order_details.ProductID__northwind_products.ProductID']);
  for (const id of accepted) { const review = byId.get(id)!; assert.equal(review.adversarialPass, 'COMPLETED'); assert.equal(review.label, 'revisado por modelo con pase adversarial'); }
  // The third FK stays deferred for a data reason, not a code one: its judge-a answer was cut at 400 tokens in the recording.
  const third = byId.get(FK[0]!)!;
  assert.equal(third.decision, 'defer'); assert.deepEqual(third.evaluations.map(item => item.status), ['INVALID', 'VALID']);
  assert.ok(third.evaluations[0]!.call!.truncated === true);
  // Homonyms and orphans: never accepted, and every judge that answered said reject.
  for (const id of ORPHANS_AND_HOMONYMS) { const review = byId.get(id)!; assert.notEqual(review.decision, 'accept', id); for (const evaluation of review.evaluations.filter(item => item.status === 'VALID')) assert.equal(evaluation.decision, 'reject', id); }
  assert.equal(result.contracts.length, 2); assert.ok(result.contracts.every(contract => contract.reviewOrigin === 'MODEL_REVIEWED'));
});
