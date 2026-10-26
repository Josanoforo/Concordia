import test from 'node:test';
import assert from 'node:assert/strict';
import { rangeBiasOf, runPostComa, type ProfileSource, type TieBreaker } from '../src/agent/post-coma.ts';
import { RunBudget, budgetedClient, limitsFromBounds } from '../src/agent/run-budget.ts';
import type { ColumnProfile } from '../src/probe/column-profile.ts';

const col = (name: string) => ({ name, type: 'string' });
type T = { cols: string[]; rows: string[][] };
const make = (tables: Record<string, T>) => {
  const cfg: any = { tables: Object.fromEntries(Object.entries(tables).map(([n, t]) => [n, { db: 'T', physicalTable: n, columns: t.cols.map(col), keyColumns: [], labels: [], role: 'table' }])) };
  const discovery = { tables: Object.fromEntries(Object.entries(tables).map(([n, t]) => [n, { columns: t.cols, sample: { rows: t.rows } }])) };
  const client: any = { async runSql(sql: string) {
    const from = sql.slice(sql.indexOf(' FROM ')).split(' WHERE ')[0];
    const name = Object.keys(tables).sort((a, b) => b.length - a.length).find(n => new RegExp(`\\b${n}\\b`).test(from))!;
    const inList = [...sql.matchAll(/'(\d+)'/g)].map(m => m[1]);
    return { sql, rows: tables[name].rows.filter(r => inList.includes(r[0])), requestId: 'r', queryId: 'q', durationMs: 0, utc: 'x' };
  } };
  return { cfg, discovery, client };
};
const proposal = (fromTable: string, fromColumn: string, toTable: string, toColumn: string, rawScore = 0.9) => ({ providerId: 'p', providerVersion: '1', method: 'COMA', from: { db: 'T', table: fromTable, column: fromColumn }, to: { db: 'T', table: toTable, column: toColumn }, rawScore, reason: 'COMA_COLUMN_PAIR_OUT_OF_SCOPE', verificationStatus: 'NO VERIFICADO/UNKNOWN' as const, reviewState: 'PENDING' as const, inputHash: 'h', configHash: 'c', evidenceRefs: [] });
const thresholds = { sustainedOverlap: 0.8, sustainedLabelAgreement: 0.8, misleadingLabelAgreement: 0.5 };
const measured = (table: string, column: string, rows: number, distinct: number, extra: { min?: number; max?: number } = {}): ColumnProfile => ({ table, column, provenance: 'GLOBAL_WHOLE_TABLE', form: extra.min === undefined ? 'F1' : 'F1x', rows, distinct, nulls: 0, ...extra });
const profileSource = (profiles: ColumnProfile[]): ProfileSource => async e => profiles.find(p => p.table === e.table && p.column === e.column);
const go = (env: ReturnType<typeof make>, proposals: any[], extra: { postComa?: any; profile?: ProfileSource; tieBreak?: TieBreaker } = {}) => {
  const budget = new RunBudget(limitsFromBounds({}));
  return runPostComa({ cfg: env.cfg, catalog: { postComa: { maxProbes: 10, blind: true, ...extra.postComa } } as any, discovery: env.discovery, proposals, client: budgetedClient(env.client, budget) as any, budget, thresholds, ...(extra.profile ? { profile: extra.profile } : {}), ...(extra.tieBreak ? { tieBreak: extra.tieBreak } : {}) });
};
const promo = () => make({ promotion: { cols: ['p_end_date_sk'], rows: [['10'], ['11'], ['12']] }, date_dim: { cols: ['d_date_sk'], rows: [['10'], ['11'], ['12']] } });

test('E2-02: both ends unique in the sample, the global profile orients promotion.p_end_date_sk -> date_dim', async () => {
  const reversed = proposal('date_dim', 'd_date_sk', 'promotion', 'p_end_date_sk');
  const without = await go(promo(), [reversed]);
  assert.equal(without.proposals[0].from.table, 'date_dim', 'no profile: the sample cannot orient it (the offline REVERSED case)');
  const profile = profileSource([measured('promotion', 'p_end_date_sk', 1000, 300), measured('date_dim', 'd_date_sk', 73049, 73049)]);
  const withProfile = await go(promo(), [reversed], { profile });
  const p = withProfile.proposals[0];
  assert.deepEqual([p.from.table, p.to.table, p.structure!.orientation, p.structure!.rankClass], ['promotion', 'date_dim', 'SWAPPED_GLOBAL_UNIQUENESS', 'KEY_CANDIDATE']);
  assert.deepEqual(p.structure!.globalUniqueness, { from: 'NOT_UNIQUE', to: 'UNIQUE', provenance: 'GLOBAL_WHOLE_TABLE' });
  assert.equal(p.verificationStatus, 'NO VERIFICADO/UNKNOWN');
});

test('E2-02: both ends globally unique is a 1:1 extension, kept as proposed, eligible and carrying the trait', async () => {
  const profile = profileSource([measured('promotion', 'p_end_date_sk', 1000, 1000), measured('date_dim', 'd_date_sk', 73049, 73049)]);
  const r = await go(promo(), [proposal('promotion', 'p_end_date_sk', 'date_dim', 'd_date_sk')], { profile });
  const p = r.proposals[0];
  assert.deepEqual([p.from.table, p.structure!.rankClass, p.structure!.globalUniqueness!.relationKind], ['promotion', 'ONE_TO_ONE', 'EXTENSION_ONE_TO_ONE']);
  const d = p.coverageProbe.diagnostic!;
  assert.deepEqual([d.traits, d.suspect.value, d.suspect.reasons], [['ONE_TO_ONE_EXTENSION'], false, []], 'an evidence trait, not a suspicion: the candidate stays eligible for review');
  assert.match(d.counterfactual, /EXTENSION_ONE_TO_ONE/);
});

test('E2-02: an unmeasured profile leaves the pair as it was, and the sample still wins when it already orients', async () => {
  const notMeasured: ProfileSource = async e => ({ table: e.table, column: e.column, provenance: 'NOT_MEASURED', reason: 'QUERY_FAILED' });
  const r = await go(promo(), [proposal('date_dim', 'd_date_sk', 'promotion', 'p_end_date_sk')], { profile: notMeasured });
  assert.deepEqual([r.proposals[0].from.table, r.proposals[0].structure!.globalUniqueness], ['date_dim', undefined]);
  const read: string[] = [];
  const env = make({ promotion: { cols: ['p_end_date_sk'], rows: [['10'], ['10'], ['11']] }, date_dim: { cols: ['d_date_sk'], rows: [['10'], ['11'], ['12']] } });
  await go(env, [proposal('date_dim', 'd_date_sk', 'promotion', 'p_end_date_sk')], { profile: async e => { read.push(`${e.table}.${e.column}`); return undefined; } });
  assert.deepEqual(read, ['date_dim.d_date_sk'], 'a pair the sample orients spends no orientation reads; only the probed target is read for the range reading');
});

test('E2-06: probed keys in a short prefix of the target range are flagged RANGE_BIASED with their numbers', async () => {
  const env = make({ broker: { cols: ['b_id'], rows: [['1'], ['2'], ['3']] }, trade: { cols: ['t_id'], rows: [['1'], ['2'], ['3'], ['4'], ['5']] } });
  const flagged = await go(env, [proposal('broker', 'b_id', 'trade', 't_id')], { profile: profileSource([measured('trade', 't_id', 10000, 10000, { min: 1, max: 10000 }), measured('broker', 'b_id', 100, 3)]) });
  const d = flagged.proposals[0].coverageProbe.diagnostic!;
  assert.ok(d.suspect.reasons.includes('RANGE_BIASED'));
  assert.deepEqual([d.rangeBias!.probedMax, d.rangeBias!.targetMax, d.rangeBias!.prefixFraction, d.rangeBias!.provenance], [3, 10000, 0.1, 'GLOBAL_WHOLE_TABLE']);
  const wide = await go(env, [proposal('broker', 'b_id', 'trade', 't_id')], { profile: profileSource([measured('trade', 't_id', 5, 5, { min: 1, max: 5 }), measured('broker', 'b_id', 3, 3)]) });
  assert.equal(wide.proposals[0].coverageProbe.diagnostic!.suspect.reasons.includes('RANGE_BIASED'), false);
  assert.equal(wide.proposals[0].coverageProbe.diagnostic!.rangeBias!.flagged, false);
});

test('E2-06: no F1x min/max, non numeric keys or a single key give no reading', () => {
  assert.equal(rangeBiasOf(['1', '2'], measured('t', 'c', 10, 10)), undefined);
  assert.equal(rangeBiasOf(['a', 'b'], measured('t', 'c', 10, 10, { min: 1, max: 100 })), undefined);
  assert.equal(rangeBiasOf(['1'], measured('t', 'c', 10, 10, { min: 1, max: 100 })), undefined);
  assert.equal(rangeBiasOf(['1', '2'], undefined), undefined);
});

const homonym = (extraColumns: string[] = []) => make({
  web_sales: { cols: ['ws_ship_mode_date_sk', ...extraColumns], rows: [['1', '1'], ['2', '2'], ['3', '3'], ['1', '1'], ['2', '2'], ['3', '3']].map(r => r.slice(0, 1 + extraColumns.length)) },
  date_dim: { cols: ['d_date_sk'], rows: [['1'], ['2'], ['3']] },
  ship_mode: { cols: ['sm_ship_mode_sk'], rows: [['1'], ['2'], ['3']] }
});
const pair = [proposal('web_sales', 'ws_ship_mode_date_sk', 'date_dim', 'd_date_sk'), proposal('web_sales', 'ws_ship_mode_date_sk', 'ship_mode', 'sm_ship_mode_sk')];

test('E2-04: a role dimension is not marked COMPETING_TARGET; without the second role column it is', async () => {
  const single = await go(homonym(), pair, { postComa: { homonymGuard: true } });
  const loser = (r: any) => r.proposals.find((p: any) => p.to.table === 'date_dim' && p.from.column === 'ws_ship_mode_date_sk').coverageProbe.diagnostic;
  assert.deepEqual(loser(single).suspect.reasons, ['COMPETING_TARGET'], 'one column pointing at date_dim: an ordinary rival');
  const roles = await go(homonym(['ws_sold_date_sk']), [...pair, proposal('web_sales', 'ws_sold_date_sk', 'date_dim', 'd_date_sk')], { postComa: { homonymGuard: true } });
  const d = loser(roles);
  assert.deepEqual([d.suspect.reasons, d.roleDimension], [[], { targetTable: 'date_dim', sourceColumns: ['ws_ship_mode_date_sk', 'ws_sold_date_sk'] }]);
});

test('X10 vector: a decisive vector picks the winner and is recorded; a non decisive one leaves the name affinity', async () => {
  const stub = (winnerTable: string | null): TieBreaker => ({ orderTies: (group: any) => ({ ordered: winnerTable ? [...group].sort((a: any, b: any) => Number(b.to.table === winnerTable) - Number(a.to.table === winnerTable)) : [...group], decisive: winnerTable !== null, reason: winnerTable ? 'DECIDED_BY_CARDINALITY_DISTINCT: test' : 'NOT_DECISIVE', decidedBy: winnerTable ? 'CARDINALITY_DISTINCT' : null, siblings: [], vectors: [], trace: [] }) as any });
  const profile = profileSource([]);
  const decisive = await go(homonym(), pair, { postComa: { homonymGuard: true }, profile, tieBreak: stub('date_dim') });
  const ship = decisive.proposals.find(p => p.to.table === 'ship_mode')!.coverageProbe.diagnostic!;
  assert.deepEqual([ship.suspect.reasons, ship.tieBreak!.decidedBy], [['COMPETING_TARGET'], 'CARDINALITY_DISTINCT'], 'the vector overrode the name affinity (which preferred ship_mode)');
  const open = await go(homonym(), pair, { postComa: { homonymGuard: true }, profile, tieBreak: stub(null) });
  assert.deepEqual(open.proposals.find(p => p.to.table === 'date_dim')!.coverageProbe.diagnostic!.suspect.reasons, ['COMPETING_TARGET'], 'not decisive: name affinity as before');
});

test('X10 vector in the ranking: equal tier and raw score siblings follow a decisive vector, otherwise the id order', async () => {
  const stub: TieBreaker = { orderTies: (group: any) => ({ ordered: [...group].sort((a: any, b: any) => b.id.localeCompare(a.id)), decisive: true, reason: 'DECIDED_BY_NAME_VS_TABLE', decidedBy: 'NAME_VS_TABLE', siblings: [], vectors: [], trace: [] }) as any };
  const base = await go(homonym(), pair, { postComa: { maxProbes: 1 } });
  const ordered = await go(homonym(), pair, { postComa: { maxProbes: 1 }, profile: profileSource([]), tieBreak: stub });
  assert.notEqual(base.proposals[0].proposalId, ordered.proposals[0].proposalId);
  assert.equal(ordered.proposals[0].coverageProbe.status, 'EXECUTED');
});
