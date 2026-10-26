import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewBlindCandidates } from '../src/agent/model-review/candidates.ts';
import { deterministicAttacks } from '../src/agent/model-review/deterministic-attacks.ts';
import { buildPackets, type ProbedProposalInput } from '../src/agent/model-review/evidence.ts';
import { evidenceFloor } from '../src/agent/model-review/floors.ts';
import { adversaryMessages, judgeMessages } from '../src/agent/model-review/prompts.ts';
import { standInAdversary, standInJudge } from '../src/agent/model-review/standin.ts';
import { RunBudget } from '../src/agent/run-budget.ts';

/**
 * Round 10 closing piece (X8), from X9's finding on the live M12 run: the packet counted the 1-key discovery sample although F4 had read and tested the global distinct keys, so three
 * relations were deferred with INSUFFICIENT_DISTINCT_KEYS. The packet now says what the source key count is a count of (`sourceKeys.basis`). The minimum is the same for both bases.
 */
const budget = () => new RunBudget({ maxQueriesPerRun: 5, readLimit: 50, maxTokensPerRun: 5_000_000, maxSteps: 3 });
const defaults = { universeId: 'T', database: 'T_DB', normalization: 'text', normalizationVersion: 'text-exact-v1', normalizationAdapterCapability: 'exact-text' };
const ID = 'web_sales.ws_bill_customer_sk__customer.c_customer_sk';
const proposal = (distinctKeys: number, fromBasis?: string): ProbedProposalInput => ({
  proposalId: ID, from: { table: 'web_sales', column: 'ws_bill_customer_sk' }, to: { table: 'customer', column: 'c_customer_sk' },
  coverageProbe: { status: 'EXECUTED', diagnostic: { coverage: { level: 'HIGH', matched: 5, probed: 5, threshold: 0.8 },
    multiplicity: { from: { rows: 5, distinctKeys, maxRowsPerKey: 1 }, to: { rows: 5, distinctKeys: 5, maxRowsPerKey: 1 }, ...(fromBasis === undefined ? {} : { fromBasis }) },
    keyRules: { inclusion: { status: 'NO_VIOLATION_IN_SAMPLE', missingCount: 0 }, targetUniqueness: { status: 'NO_DUPLICATES_IN_SAMPLE' } } } }
});
const packetOf = (distinctKeys: number, fromBasis?: string, minDistinctKeys = 3) => buildPackets([proposal(distinctKeys, fromBasis)], { minDistinctKeys }).packets[0]!;

test('the basis defaults to DISCOVERY_SAMPLE, and an unknown value never claims a global read', () => {
  assert.equal(packetOf(5).sourceKeys.basis, 'DISCOVERY_SAMPLE');
  assert.equal(packetOf(5, 'DISCOVERY_SAMPLE').sourceKeys.basis, 'DISCOVERY_SAMPLE');
  assert.equal(packetOf(5, 'GLOBAL_EVERYTHING').sourceKeys.basis, 'DISCOVERY_SAMPLE');
  assert.equal(packetOf(5, 'GLOBAL_DISTINCT_F4').sourceKeys.basis, 'GLOBAL_DISTINCT_F4');
});

test("X4's final location, multiplicity.from.fromBasis, is read; it wins over the level above", () => {
  const nested = proposal(5);
  nested.coverageProbe!.diagnostic!.multiplicity = { from: { rows: 5, distinctKeys: 5, maxRowsPerKey: 1, fromBasis: 'GLOBAL_DISTINCT_F4' }, to: { rows: 5, distinctKeys: 5, maxRowsPerKey: 1 } };
  assert.equal(buildPackets([nested], { minDistinctKeys: 3 }).packets[0]!.sourceKeys.basis, 'GLOBAL_DISTINCT_F4');
  const both = proposal(5, 'DISCOVERY_SAMPLE');
  both.coverageProbe!.diagnostic!.multiplicity!.from = { rows: 5, distinctKeys: 5, maxRowsPerKey: 1, fromBasis: 'GLOBAL_DISTINCT_F4' };
  assert.equal(buildPackets([both], { minDistinctKeys: 3 }).packets[0]!.sourceKeys.basis, 'GLOBAL_DISTINCT_F4');
  const { basis: _basis, ...counts } = buildPackets([nested], { minDistinctKeys: 3 }).packets[0]!.sourceKeys;
  assert.deepEqual(counts, { rows: 5, distinctKeys: 5, maxRowsPerKey: 1 }, 'fromBasis does not leak into the counts');
});

test('apart from the new field a normal packet is unchanged', () => {
  const plain = packetOf(5), f4 = packetOf(5, 'GLOBAL_DISTINCT_F4');
  const { basis: _plainBasis, ...plainKeys } = plain.sourceKeys, { basis: _f4Basis, ...f4Keys } = f4.sourceKeys;
  assert.deepEqual(plainKeys, { rows: 5, distinctKeys: 5, maxRowsPerKey: 1 });
  assert.deepEqual(f4Keys, plainKeys);
  assert.deepEqual({ ...f4, sourceKeys: plain.sourceKeys }, plain, 'the basis is the only difference between the two packets');
});

test('an F4 packet with 5 global keys is not deferred for INSUFFICIENT_DISTINCT_KEYS; the same discovery sample of 1 key still is', () => {
  const f4 = packetOf(5, 'GLOBAL_DISTINCT_F4'), sample = packetOf(1);
  const floor = evidenceFloor(f4);
  assert.equal(floor.cap, 'accept');
  assert.ok(!floor.reasons.includes('INSUFFICIENT_DISTINCT_KEYS'));
  assert.equal(deterministicAttacks(f4)[0]!.outcome, 'NO_ATTACK');
  const sampleFloor = evidenceFloor(sample);
  assert.equal(sampleFloor.cap, 'defer');
  assert.ok(sampleFloor.reasons.includes('INSUFFICIENT_DISTINCT_KEYS'));
  assert.equal(deterministicAttacks(sample)[0]!.outcome, 'SUSTAINED');
});

test('the threshold is not loosened: an F4 count below the minimum defers, and at the minimum it only annotates', () => {
  const below = packetOf(2, 'GLOBAL_DISTINCT_F4', 3), atMinimum = packetOf(5, 'GLOBAL_DISTINCT_F4', 5);
  const belowFloor = evidenceFloor(below);
  assert.equal(belowFloor.cap, 'defer');
  assert.ok(belowFloor.reasons.includes('INSUFFICIENT_DISTINCT_KEYS'));
  assert.match(belowFloor.notes.join(' '), /global distinct keys read with F4/);
  assert.equal(deterministicAttacks(below)[0]!.outcome, 'SUSTAINED');
  assert.match(deterministicAttacks(below)[0]!.argument, /global distinct keys read with F4/);
  const minimumFloor = evidenceFloor(atMinimum);
  assert.equal(minimumFloor.cap, 'accept');
  assert.ok(minimumFloor.annotations.includes('AT_MINIMUM_KEYS'));
  assert.equal(deterministicAttacks(atMinimum)[0]!.outcome, 'SURVIVED');
  assert.match(evidenceFloor(packetOf(1)).notes.join(' '), /discovery sample/);
});

test('both prompts carry the basis, and say what each basis counts', () => {
  const packet = packetOf(5, 'GLOBAL_DISTINCT_F4');
  for (const messages of [judgeMessages(packet, 'A'), adversaryMessages(packet, [])]) {
    const system = messages[0]!.content, user = JSON.parse(messages[1]!.content) as { packet: { sourceKeys: { basis: string } } };
    assert.equal(user.packet.sourceKeys.basis, 'GLOBAL_DISTINCT_F4');
    assert.match(system, /global distinct keys read with F4/);
    assert.match(system, /discovery sample/);
  }
});

test('end to end: the F4 relation reaches an accept contract from the stand-in panel, the discovery-sample one stays deferred', async () => {
  const run = async (items: ProbedProposalInput[]) => (await reviewBlindCandidates({ proposals: items, universeId: 'T', context: { minDistinctKeys: 3 },
    judges: [standInJudge('a', 'SEMANTIC'), standInJudge('b', 'SEMANTIC')], adversary: standInAdversary('adv'), budget: budget(), config: { minDistinctKeys: 3 }, defaults, allowStandIn: true })).overlay.reviews;
  const [f4] = await run([proposal(5, 'GLOBAL_DISTINCT_F4')]), [sample] = await run([proposal(1)]);
  assert.ok(f4 && sample);
  assert.ok(!f4.reasons.includes('INSUFFICIENT_DISTINCT_KEYS'));
  assert.equal(f4.decision, 'accept');
  assert.equal(sample.decision, 'defer');
  assert.ok(sample.reasons.includes('INSUFFICIENT_DISTINCT_KEYS'));
});
