import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { reviewBlindCandidates } from '../src/agent/model-review/candidates.ts';
import { buildPackets } from '../src/agent/model-review/evidence.ts';
import { classifyAttacks } from '../src/agent/model-review/aggregate.ts';
import { adversaryMessages, parseAttacks } from '../src/agent/model-review/prompts.ts';
import { evidenceFloor } from '../src/agent/model-review/floors.ts';
import { DEFAULT_MAX_OUTPUT_TOKENS_ADVERSARY, MAX_OUTPUT_TOKENS_CEILING } from '../src/agent/model-review/reviewer.ts';
import { attackAnswer, StandInModel } from '../src/agent/model-review/standin.ts';
import type { GlobalUniqueness, ModelMessage, ReviewModel } from '../src/agent/model-review/types.ts';
import { RunBudget } from '../src/agent/run-budget.ts';

/**
 * Regression with the REAL answers of the live NWCH re-check (agent-nwch-r9-blind-live-02), sanitized. It went from 0 to 1 of 3 approved. Two things remained:
 * (1) the adversary answer for ProductID was cut at 2000 output tokens (the model spends output tokens before the JSON, and wrote long arguments for four families);
 * (2) the adversary sustained a SIBLING attack on album.ArtistId -> artist because album.ArtistId -> playlist_track.TrackId has the same 15/15 in the sample, although TrackId
 *     is not globally unique and so cannot be the target of a foreign key. Nothing here is live.
 */
interface Recorded { relationId: string; stage: 'EVALUATION' | 'ATTACK'; slot: number; actor: string; outputTokens: number; responseText: string }
const here = path.resolve(import.meta.dirname, 'fixtures', 'model-review');
const one = JSON.parse(fs.readFileSync(path.join(here, 'nwch-live-01.json'), 'utf8')) as { proposals: any[] };
const two = JSON.parse(fs.readFileSync(path.join(here, 'nwch-live-02.json'), 'utf8')) as { responses: Recorded[] };
const ARTIST = 'chinook_album.ArtistId__chinook_artist.ArtistId', ORDER = 'northwind_order_details.OrderID__northwind_orders.OrderID', PRODUCT = 'northwind_order_details.ProductID__northwind_products.ProductID';
const defaults = { universeId: 'NWCH', database: 'NWCH_DB', normalization: 'text', normalizationVersion: 'text-exact-v1', normalizationAdapterCapability: 'exact-text' };
const F1: Record<string, GlobalUniqueness> = { 'chinook_playlist_track.TrackId': 'NOT_UNIQUE', 'chinook_artist.ArtistId': 'UNIQUE', 'northwind_orders.OrderID': 'UNIQUE', 'northwind_products.ProductID': 'UNIQUE' };
const record = (relationId: string, stage: 'EVALUATION' | 'ATTACK', slot = 0) => two.responses.find(item => item.relationId === relationId && item.stage === stage && item.slot === slot)!;
const relationOf = (messages: readonly ModelMessage[]) => JSON.parse(messages[1]!.content).packet.relationId as string;
const replay = (id: string, stage: 'EVALUATION' | 'ATTACK', slot: number, fallback?: (messages: readonly ModelMessage[]) => string) => Object.assign(new StandInModel(id, messages => {
  const found = two.responses.find(item => item.relationId === relationOf(messages) && item.stage === stage && item.slot === slot);
  if (found) return { status: 'PASS', responseText: found.responseText, receipt: { receiptId: 'replay', provider: 'replay', model: 'replay', inputTokens: 1000, outputTokens: found.outputTokens, totalTokens: 1000 + found.outputTokens, latencyMs: 0, fromCache: false }, truncated: found.outputTokens >= 2000 };
  return fallback ? fallback(messages) : { status: 'FAIL', error: { code: 'NOT_RECORDED' } };
}), { kind: 'LIVE_MODEL' as const }) as ReviewModel;
const run = (globalTargetUniqueness?: Record<string, GlobalUniqueness>) => reviewBlindCandidates({ proposals: one.proposals, universeId: 'NWCH', context: { minDistinctKeys: 3, ...(globalTargetUniqueness ? { globalTargetUniqueness } : {}) },
  judges: [replay('judge-a', 'EVALUATION', 0), replay('judge-b', 'EVALUATION', 1)],
  // Relations not recorded in this capture (the homonyms) are answered by the offline adversary, which they never reach in practice: judges reject first.
  adversary: replay('adversary', 'ATTACK', 0, messages => attackAnswer(JSON.parse(messages[1]!.content).packet)),
  budget: new RunBudget({ maxQueriesPerRun: 5, readLimit: 50, maxTokensPerRun: 1_000_000, maxSteps: 3 }), config: { minDistinctKeys: 3 }, defaults });
const packetsWith = (map?: Record<string, GlobalUniqueness>) => buildPackets(one.proposals, { minDistinctKeys: 3, ...(map ? { globalTargetUniqueness: map } : {}) }).packets;

test('the real ProductID adversary answer was cut at 2000 tokens and does not parse; the adversary cap is now 3000, the client allows it, and the prompt asks for terse answers', () => {
  const cut = record(PRODUCT, 'ATTACK');
  assert.equal(cut.outputTokens, 2000); assert.equal(parseAttacks(cut.responseText, PRODUCT), undefined);
  assert.ok(cut.responseText.length < 1500, 'the visible text is short: the rest of the cap went to output the model never showed');
  assert.equal(DEFAULT_MAX_OUTPUT_TOKENS_ADVERSARY, 3000); assert.equal(MAX_OUTPUT_TOKENS_CEILING, 3000);
  const clientCap = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'config', 'budget.json'), 'utf8')).maxTokensPerGeneration;
  assert.ok(clientCap >= DEFAULT_MAX_OUTPUT_TOKENS_ADVERSARY, `config/budget.json maxTokensPerGeneration ${clientCap} must allow the adversary cap`);
  const system = adversaryMessages(packetsWith()[0]!, [])[0]!.content;
  assert.match(system, /argument "" and evidenceRefs \[\]/); assert.match(system, /at most 200 characters/); assert.match(system, /exactly ONE JSON object/);
});

test('the real ArtistId adversary answer sustains a SIBLING attack on the tie; with the measured global uniqueness of TrackId the same answer is REFUTED and the FK is accepted', async () => {
  const text = record(ARTIST, 'ATTACK').responseText, parsed = parseAttacks(text, ARTIST)!;
  const sibling = parsed.find(item => item.family === 'SIBLING')!;
  assert.deepEqual([sibling.severity, sibling.evidenceRefs[0]], ['blocking', 'siblings[5].coverage.matched']);
  const without = classifyAttacks(packetsWith().find(item => item.relationId === ARTIST)!, parsed).find(item => item.family === 'SIBLING')!;
  assert.equal(without.outcome, 'SUSTAINED', 'no measurement: the tie stands (this is the live outcome)');
  const packet = packetsWith(F1).find(item => item.relationId === ARTIST)!;
  assert.equal(packet.siblings[5]!.relationId, 'chinook_album.ArtistId__chinook_playlist_track.TrackId'); assert.equal(packet.siblings[5]!.otherGlobalUniqueness, 'NOT_UNIQUE');
  assert.equal(packet.target.globalUniqueness, 'UNIQUE');
  assert.equal(classifyAttacks(packet, parsed).find(item => item.family === 'SIBLING')!.outcome, 'REFUTED');

  const before = (await run()).run.reviews.find(item => item.relationId === ARTIST)!, after = (await run(F1)).run.reviews.find(item => item.relationId === ARTIST)!;
  assert.equal(before.decision, 'defer'); assert.deepEqual(before.attacksSustained.map(item => item.family), ['SIBLING']);
  assert.equal(after.decision, 'accept'); assert.equal(after.adversarialPass, 'COMPLETED'); assert.equal(after.attacksSustained.length, 0);
  assert.ok(after.attacksSurvived.some(item => item.family === 'SIBLING' && item.outcome === 'REFUTED'));
  assert.ok(after.notes.some(note => note.includes('refuted')));
});

test('the measured uniqueness only refutes a sibling attack that cites tied siblings with a NOT_UNIQUE target; a unique or unmeasured sibling still sustains it', () => {
  const parsed = parseAttacks(record(ARTIST, 'ATTACK').responseText, ARTIST)!;
  const outcome = (map?: Record<string, GlobalUniqueness>) => classifyAttacks(packetsWith(map).find(item => item.relationId === ARTIST)!, parsed).find(item => item.family === 'SIBLING')!.outcome;
  assert.equal(outcome({ 'chinook_playlist_track.TrackId': 'UNIQUE' }), 'SUSTAINED');
  assert.equal(outcome({ 'chinook_artist.ArtistId': 'UNIQUE' }), 'SUSTAINED', 'the sibling target was not measured');
  assert.equal(outcome({ 'chinook_playlist_track.TrackId': 'NOT_UNIQUE' }), 'REFUTED');
  // A refutation never touches other families, and never turns a sustained attack on a different sibling into a pass.
  const mixed = parsed.map(item => item.family === 'SIBLING' ? { ...item, evidenceRefs: ['siblings[5].coverage.matched', 'siblings[0]'] } : item);
  assert.equal(classifyAttacks(packetsWith({ 'chinook_playlist_track.TrackId': 'NOT_UNIQUE' }).find(item => item.relationId === ARTIST)!, mixed).find(item => item.family === 'SIBLING')!.outcome, 'SUSTAINED', 'a cited sibling that is not NOT_UNIQUE keeps the attack alive');
});

test('a target measured NOT globally unique is rejected by the floor with no model call; the homonym TrackId candidates cost nothing once F1 is known', async () => {
  const packet = packetsWith(F1).find(item => item.relationId === 'chinook_album.ArtistId__chinook_playlist_track.TrackId')!;
  const floor = evidenceFloor(packet);
  assert.equal(floor.cap, 'reject'); assert.ok(floor.reasons.includes('TARGET_NOT_UNIQUE'));
  const result = await run(F1), review = result.run.reviews.find(item => item.relationId === packet.relationId)!;
  assert.deepEqual([review.decision, review.calls, review.tokens], ['reject', 0, 0]);
  assert.equal(evidenceFloor(packetsWith().find(item => item.relationId === packet.relationId)!).cap, 'accept', 'without F1 the floor cannot know');
});

test('the other two real answers still behave: OrderID accepted, ProductID deferred because its adversary answer was cut (no retry)', async () => {
  const result = await run(F1), byId = new Map(result.run.reviews.map(item => [item.relationId, item]));
  assert.equal(byId.get(ORDER)!.decision, 'accept');
  const product = byId.get(PRODUCT)!;
  assert.equal(product.decision, 'defer'); assert.equal(product.adversary.status, 'INVALID'); assert.equal(product.adversarialPass, 'INCOMPLETE');
  assert.equal(product.adversary.call!.truncated, true); assert.equal(product.calls, 3, 'two judges and one adversary call, no retry');
  assert.deepEqual(result.contracts.map(item => item.id).sort(), [ARTIST, ORDER].sort());
});
