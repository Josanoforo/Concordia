import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { offlineAgentDeps } from '../src/agent/offline-deps.ts';
import { createCandidateReview, globalUniquenessOf } from '../src/agent/model-review/candidate-review.ts';
import { attackAnswer, judgeAnswer, StandInModel } from '../src/agent/model-review/standin.ts';
import type { ModelMessage, ReviewPacket } from '../src/agent/model-review/types.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/**
 * End to end, engine -> reviewer (NWCH fixture with the tie, the engine's own tie evidence F1, createCandidateReview with stand-ins): the packet the judges and the
 * adversary see carries the target's global uniqueness and the tied sibling's. A name mismatch between the engine field (`targetGlobalUniqueness`, counts) and the reviewer
 * read would leave these undefined and the ArtistId tie would stay deferred (it did, until the reviewer read the engine's field).
 */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const fixture = () => structuredClone(agentFixtures().find(item => item.alias === 'NWCH')!);
function profile(table: string, column: string) {
  const t = (fixture().tables as any)[table], index = t.columns.findIndex((c: any) => c.name === column), values = t.rows.map((row: unknown[]) => row[index]);
  const present = values.filter((v: unknown) => v !== null && v !== undefined);
  return { rows: values.length, distinct: new Set(present).size, nulls: values.length - present.length };
}
/** Spies on every prompt (the packet is the user message) and answers like the offline stand-in. */
const spies = () => {
  const packets: { stage: 'EVALUATION' | 'ATTACK'; packet: ReviewPacket }[] = [];
  const capture = (stage: 'EVALUATION' | 'ATTACK', messages: readonly ModelMessage[]) => { const packet = JSON.parse(messages[1]!.content).packet as ReviewPacket; packets.push({ stage, packet }); return packet; };
  return { packets, judges: [new StandInModel('spy-judge-a', m => judgeAnswer('SEMANTIC', capture('EVALUATION', m))), new StandInModel('spy-judge-b', m => judgeAnswer('SEMANTIC', capture('EVALUATION', m)))], adversary: new StandInModel('spy-adversary', m => attackAnswer(capture('ATTACK', m))) };
};

test('engine -> reviewer: the packet carries the target global uniqueness and the tied sibling, measured by the engine, with keys that match the reviewer ("table.column", no db)', async () => {
  const seen = spies(), f = fixture();
  const base = offlineAgentDeps('NWCH', f, new Script([...f.chooserScript])), cfg = universeConfig('NWCH'), physical = Object.fromEntries(Object.entries<any>(cfg.tables).map(([name, spec]) => [spec.physicalTable, name]));
  // The offline fixture client answers the bounded profile only; the whole-table F1 form is answered from the same fixture rows (as the engine tie-evidence test does).
  const client = { ...base.client, runSql: async (sql: string, limit?: number) => {
    const whole = /^SELECT COUNT\(\*\) AS concordia_rows, COUNT\(DISTINCT `?(\w+)`?\) AS concordia_distinct, SUM\(CASE WHEN `?\w+`? IS NULL THEN 1 ELSE 0 END\) AS concordia_nulls FROM (.+)$/i.exec(sql);
    if (!whole || /LIMIT \d+\) concordia_bounded$/i.test(sql)) return (base.client as any).runSql(sql, limit);
    const table = Object.keys(physical).map(name => physical[name]!).find(name => whole[2]!.includes(cfg.tables[name].physicalTable))!, p = profile(table, whole[1]!);
    // The offline NWCH rows have no duplicated tied target, so make one: northwind_orders.OrderID is reported with repeated keys (the role TrackId plays in the live schema).
    if (table === 'northwind_orders' && whole[1] === 'OrderID') p.distinct = 5;
    return { sql, rows: [[p.rows, p.distinct, p.nulls]], requestId: 'fx-f1', queryId: 'fx-f1', durationMs: 0, utc: 'x' };
  } };
  const candidateReview = createCandidateReview({ judges: seen.judges, adversary: seen.adversary, thresholds: { minDistinctKeys: 3 } });
  const report: any = await runAgent('NWCH', 'agent-x8-e2e', { ...base, client: client as any, persist: false, critic: false, candidateReview });
  const section = report.phases.candidateReview;
  assert.ok(section.tieEvidence.measured && Object.keys(section.tieEvidence.measured).length >= 2, JSON.stringify(section.tieEvidence).slice(0, 300));
  const measured: string[] = Object.keys(section.tieEvidence.measured);
  assert.ok(seen.packets.length > 0, 'the reviewer reached the judges');

  // 1. Every packet's target and every sibling target that the engine measured carries the verdict, and nothing unmeasured carries one.
  let withTarget = 0, withSibling = 0;
  for (const { packet } of seen.packets) {
    const key = `${packet.target.table}.${packet.target.column}`, counts = section.tieEvidence.measured[key];
    if (counts) { withTarget++; assert.equal(packet.target.globalUniqueness, counts.unique ? 'UNIQUE' : 'NOT_UNIQUE', key); } else assert.equal(packet.target.globalUniqueness, undefined, `${key} was not measured`);
    for (const sibling of packet.siblings.filter(item => item.shares === 'SOURCE')) {
      const siblingKey = `${sibling.other.table}.${sibling.other.column}`, siblingCounts = section.tieEvidence.measured[siblingKey];
      if (siblingCounts) { withSibling++; assert.equal(sibling.otherGlobalUniqueness, siblingCounts.unique ? 'UNIQUE' : 'NOT_UNIQUE', siblingKey); } else assert.equal(sibling.otherGlobalUniqueness, undefined);
    }
  }
  assert.ok(withTarget > 0, 'at least one reviewed packet has a measured target');
  assert.ok(withSibling > 0, 'at least one reviewed packet has a tied sibling with a measured target');

  // 2. The tie itself: a source column with two measured targets, one unique and one not. The packet of the relation to the unique one sees the other as NOT_UNIQUE.
  assert.ok(section.tieEvidence.ties.length > 0 && measured.length >= 2);
  assert.deepEqual(measured.filter(key => !section.tieEvidence.measured[key].unique), ['northwind_orders.OrderID']);
  const refuting = seen.packets.find(({ packet }) => packet.siblings.some(item => item.shares === 'SOURCE' && item.otherGlobalUniqueness === 'NOT_UNIQUE') && packet.target.globalUniqueness === 'UNIQUE');
  assert.ok(refuting, 'a packet whose target is UNIQUE and whose tied sibling target is NOT_UNIQUE reached the reviewer: the ArtistId / TrackId tie');
  assert.equal(refuting!.packet.relationId, 'chinook_album.ArtistId__chinook_artist.ArtistId');
  assert.equal(refuting!.packet.siblings.find(item => item.shares === 'SOURCE' && item.otherGlobalUniqueness === 'NOT_UNIQUE')!.relationId, 'chinook_album.ArtistId__northwind_orders.OrderID');
  // A candidate whose OWN target was measured NOT unique is rejected by the floor: no judge ever saw it.
  assert.ok(!seen.packets.some(({ packet }) => packet.target.table === 'northwind_orders' && packet.target.column === 'OrderID'), 'no packet with a NOT_UNIQUE target reached a model');
  assert.ok(seen.packets.every(({ stage }) => stage === 'EVALUATION' || stage === 'ATTACK'));
  // 3. The adversary packet carries it too (the SIBLING refutation reads it there).
  const attackPackets = seen.packets.filter(item => item.stage === 'ATTACK');
  assert.ok(attackPackets.length === 0 || attackPackets.some(({ packet }) => packet.target.globalUniqueness !== undefined || packet.siblings.some(item => item.otherGlobalUniqueness !== undefined)));
  // The review ran and is sealed as a model review.
  assert.ok(['APPLIED', 'NOTHING_APPROVED'].includes(section.status), JSON.stringify(section).slice(0, 300));
  assert.equal(section.provenance, 'STAND_IN_OFFLINE');
});

test('the reviewer reads the engine counts first and the verdict map second; an unmeasured column is never UNIQUE by default', () => {
  const counts = (unique: boolean) => ({ rows: 10, distinct: unique ? 10 : 6, nulls: 0, unique });
  assert.deepEqual(globalUniquenessOf({ targetGlobalUniqueness: { 'a.k': counts(true), 'b.k': counts(false) } }), { 'a.k': 'UNIQUE', 'b.k': 'NOT_UNIQUE' });
  assert.deepEqual(globalUniquenessOf({ globalTargetUniqueness: { 'c.k': 'NOT_UNIQUE' } }), { 'c.k': 'NOT_UNIQUE' }, 'only the verdict map is present (older engine)');
  assert.deepEqual(globalUniquenessOf({ targetGlobalUniqueness: { 'a.k': counts(false) }, globalTargetUniqueness: { 'a.k': 'UNIQUE', 'c.k': 'UNIQUE' } }), { 'a.k': 'NOT_UNIQUE', 'c.k': 'UNIQUE' }, 'the counts win where both speak');
  assert.equal(globalUniquenessOf({}), undefined);
  assert.equal(globalUniquenessOf({ targetGlobalUniqueness: { 'a.k': { rows: 1, distinct: 1, nulls: 0 } as any } }), undefined, 'a malformed measurement is ignored, not read as unique');
});
