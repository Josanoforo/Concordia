import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { detectDerivedCopies, NAME_ABBREVIATIONS, orderTies, tieBreakVector, weakestOf, TIE_STEP_ORDER, type ProfileLike, type TieCandidate } from '../src/agent/tie-break.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';

/**
 * Round 10 / X10 (E2-01, E2-06, E2-07): the tie-break vector and the declared order. Offline, pure.
 * Fixture provenance: the NWCH tests derive their profiles from the in-repo offline fixture rows (real names, 8-row tables). Every `SYNTHETIC` profile below is illustrative
 * (TPCDS-like names and plausible scale), written by hand for this test: it is NOT a measurement and nothing in src/ reads it. No gold is used here.
 */
const prof = (rows: number, distinct: number, extra: { nulls?: number; min?: string | number; max?: string | number; avgLen?: number } = {}): ProfileLike => ({ provenance: 'GLOBAL_WHOLE_TABLE', rows, distinct, nulls: extra.nulls ?? 0, ...extra });
const edge = (from: string, to: string, extra: Partial<TieCandidate> = {}): TieCandidate => {
  const [fromTable, fromColumn] = from.split('.'), [toTable, toColumn] = to.split('.');
  return { id: `${from}__${to}`, from: { table: fromTable!, column: fromColumn! }, to: { table: toTable!, column: toColumn! }, ...extra };
};
const measured = <T>(feature: { status: string; value?: T }): T => { assert.equal(feature.status, 'MEASURED'); return feature.value as T; };

test('name score is asymmetric: the source column against the TARGET TABLE name, never the reverse', () => {
  const forward = tieBreakVector(edge('orders.customer_id', 'customers.id'));
  const backward = tieBreakVector(edge('customers.id', 'orders.customer_id'));
  assert.equal(measured(forward.nameVsTable), 1);
  assert.equal(measured(backward.nameVsTable), 0, 'a source column that names no entity matches nothing: 0 is a measurement');
  assert.equal(measured(forward.tokenContainment), 1);
  assert.equal(backward.tokenContainment.status, 'NOT_MEASURED');
  assert.equal(forward.nameVsTable.status === 'MEASURED' && forward.nameVsTable.provenance, 'NAME_ONLY');
});

test('name score: own-table prefixes and key noise are dropped, promo matches promotion, plurals match', () => {
  const score = (from: string, to: string) => measured(tieBreakVector(edge(from, to)).nameVsTable);
  assert.equal(score('store_sales.ss_store_sk', 'store.s_store_sk'), 1);
  assert.equal(score('store_sales.ss_store_sk', 'web_site.web_site_sk'), 0);
  assert.equal(score('store_sales.ss_promo_sk', 'promotion.p_promo_sk'), 1);
  assert.equal(score('store_sales.ss_promo_sk', 'reason.r_reason_sk'), 0);
  assert.equal(score('web_sales.ws_ship_date_sk', 'date_dim.d_date_sk'), 1, 'role dimension: ship/date, "date" is the entity');
  assert.equal(score('web_sales.ws_ship_mode_sk', 'ship_mode.sm_ship_mode_sk'), 2);
  assert.equal(score('inventory.inv_warehouse_sk', 'warehouse.w_warehouse_sk'), 1);
  assert.equal(score('album.ArtistId', 'artist.ArtistId'), 1, 'camelCase ArtistId -> artist');
  assert.equal(score('album.ArtistId', 'playlist_track.TrackId'), 0);
  assert.equal(score('line.OrderIDs', 'orders.id'), 1);
});

test('ratios, length difference and provenance come from whole-table profiles only; without them every one is NOT_MEASURED', () => {
  const bare = tieBreakVector(edge('a.x', 'b.y'));
  for (const name of ['distinctRatio', 'rowRatio', 'avgLenDiff', 'rangeBias', 'targetCentrality', 'sourceFanOut'] as const) assert.equal(bare[name].status, 'NOT_MEASURED', name);
  const v = tieBreakVector(edge('sales.item_sk', 'item.i_item_sk', { sourceProfile: prof(1000, 200, { avgLen: 4 }), targetProfile: prof(400, 400, { avgLen: 5.5 }) }));
  assert.equal(measured(v.distinctRatio), 0.5);
  assert.equal(measured(v.rowRatio), 2.5);
  assert.equal(measured(v.avgLenDiff), 1.5);
  assert.equal(v.distinctRatio.status === 'MEASURED' && v.distinctRatio.provenance, 'GLOBAL_WHOLE_TABLE');
  assert.equal(v.avgLenDiff.status === 'MEASURED' && v.avgLenDiff.inputs.length, 2);
});

test('a NOT_MEASURED profile propagates its reason and is never turned into a number', () => {
  const v = tieBreakVector(edge('a.x', 'b.y', { sourceProfile: prof(10, 10), targetProfile: { provenance: 'NOT_MEASURED', reason: 'QUERY_FAILED' } }));
  for (const name of ['distinctRatio', 'rowRatio', 'avgLenDiff', 'rangeBias'] as const) {
    const feature = v[name];
    assert.equal(feature.status, 'NOT_MEASURED');
    assert.match(feature.status === 'NOT_MEASURED' ? feature.reason : '', /PROFILE_NOT_MEASURED:TARGET:QUERY_FAILED/);
  }
  const zero = tieBreakVector(edge('a.x', 'b.y', { sourceProfile: prof(10, 10), targetProfile: prof(0, 0) }));
  assert.equal(zero.distinctRatio.status, 'NOT_MEASURED');
  const noLen = tieBreakVector(edge('a.x', 'b.y', { sourceProfile: prof(10, 10, { avgLen: 3 }), targetProfile: prof(10, 10) }));
  assert.equal(noLen.avgLenDiff.status, 'NOT_MEASURED');
});

test('range bias (E2-06): outside, short prefix, within; engine-typed strings; missing or incomparable bounds are NOT_MEASURED', () => {
  const bias = (s: ProfileLike, t: ProfileLike) => tieBreakVector(edge('broker.bid', 'trade.tid', { sourceProfile: s, targetProfile: t })).rangeBias;
  assert.equal(measured(bias(prof(100, 100, { min: 1, max: 100 }), prof(10000, 10000, { min: 1, max: 10000 }))), 'SHORT_PREFIX_OF_TARGET_RANGE', 'Zhang 2010: Broker 1..100 inside Trade 1..10000');
  assert.equal(measured(bias(prof(100, 100, { min: 1, max: 9000 }), prof(10000, 10000, { min: 1, max: 10000 }))), 'WITHIN_TARGET_RANGE');
  assert.equal(measured(bias(prof(100, 100, { min: 0, max: 50 }), prof(10000, 10000, { min: 1, max: 10000 }))), 'OUTSIDE_TARGET_RANGE');
  assert.equal(measured(bias(prof(100, 100, { min: 1, max: 20000 }), prof(10000, 10000, { min: 1, max: 10000 }))), 'OUTSIDE_TARGET_RANGE');
  assert.equal(measured(bias(prof(5, 5, { min: '1', max: '12' }), prof(73049, 73049, { min: '2415022', max: '2488070' }))), 'OUTSIDE_TARGET_RANGE', 'numeric strings are compared as numbers');
  assert.equal(measured(bias(prof(5, 5, { min: '2000-01-01', max: '2001-01-01' }), prof(9, 9, { min: '1999-01-01', max: '2002-01-01' }))), 'WITHIN_TARGET_RANGE');
  assert.equal(measured(bias(prof(5, 5, { min: 'a', max: 'z' }), prof(9, 9, { min: 'b', max: 'y' }))), 'OUTSIDE_TARGET_RANGE');
  assert.equal(bias(prof(5, 5), prof(9, 9, { min: 1, max: 9 })).status, 'NOT_MEASURED');
  assert.equal(bias(prof(5, 5, { min: 'a', max: 'b' }), prof(9, 9, { min: 1, max: 9 })).status, 'NOT_MEASURED');
});

test('target centrality and source fan-out are counted over the candidate set given as context, and only there', () => {
  const set = [
    edge('album.ArtistId', 'artist.ArtistId', { reachesHigh: true }), edge('album.ArtistId', 'playlist_track.TrackId', { reachesHigh: true }),
    edge('track.ArtistId', 'artist.ArtistId', { reachesHigh: true }), edge('track.AlbumId', 'album.AlbumId', { reachesHigh: false }),
  ];
  const [artist, playlist] = [tieBreakVector(set[0]!, { candidates: set }), tieBreakVector(set[1]!, { candidates: set })];
  assert.equal(measured(artist.targetCentrality), 2);
  assert.equal(measured(playlist.targetCentrality), 1);
  assert.equal(measured(artist.sourceFanOut), 2);
  assert.equal(tieBreakVector(edge('x.a', 'y.b', { reachesHigh: true }), { candidates: [] }).targetCentrality.status === 'MEASURED', true, 'the candidate itself always counts');
  assert.equal(tieBreakVector(edge('x.a', 'y.b'), { candidates: set }).sourceFanOut.status, 'NOT_MEASURED', 'reach not provided');
  assert.equal(tieBreakVector(set[0]!).targetCentrality.status, 'NOT_MEASURED', 'no context, no count');
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- orderTies

const fixture = () => structuredClone(agentFixtures().find(item => item.alias === 'NWCH')!);
/** Profile of one column straight from the offline NWCH fixture rows. */
function fixtureProfile(table: string, column: string): ProfileLike {
  const t = (fixture().tables as any)[table], index = t.columns.findIndex((c: any) => c.name === column), values = t.rows.map((row: unknown[]) => row[index]);
  const present = values.filter((v: unknown) => v !== null && v !== undefined);
  return { provenance: 'GLOBAL_WHOLE_TABLE', rows: values.length, distinct: new Set(present).size, nulls: values.length - present.length };
}

test('NWCH tie (fixture rows): album.ArtistId -> artist vs -> playlist_track.TrackId is decided by the name against the target table, with the trace', () => {
  const source = fixtureProfile('chinook_album', 'ArtistId');
  const toArtist = edge('chinook_album.ArtistId', 'chinook_artist.ArtistId', { sourceProfile: source, targetProfile: fixtureProfile('chinook_artist', 'ArtistId'), reachesHigh: true });
  const toTrack = edge('chinook_album.ArtistId', 'chinook_playlist_track.TrackId', { sourceProfile: source, targetProfile: fixtureProfile('chinook_playlist_track', 'TrackId'), reachesHigh: true });
  const result = orderTies([toTrack, toArtist]);
  assert.equal(result.decisive, true);
  assert.equal(result.decidedBy, 'NAME_VS_TABLE');
  assert.deepEqual(result.ordered.map(item => item.id), [toArtist.id, toTrack.id]);
  assert.match(result.reason, /^DECIDED_BY_NAME_VS_TABLE: chinook_album\.ArtistId__chinook_artist\.ArtistId \(1\) over /);
  assert.equal(result.trace[0]!.step, 'NAME_VS_TABLE');
  assert.deepEqual(result.trace[0]!.eliminated, [toTrack.id]);
  assert.equal(result.vectors.length, 2);
});

test('NWCH tie, SYNTHETIC Chinook-like scale: still decided by name; with the names anonymised the profiles alone separate or the tie stays deferred', () => {
  // SYNTHETIC: 347 albums reference 204 distinct artists out of 275; playlist_track has 8715 rows over 3503 distinct tracks.
  const source = prof(347, 204), artist = prof(275, 275), playlistTrack = prof(8715, 3503);
  const named = [edge('album.ArtistId', 'artist.ArtistId', { sourceProfile: source, targetProfile: artist }), edge('album.ArtistId', 'playlist_track.TrackId', { sourceProfile: source, targetProfile: playlistTrack })];
  assert.equal(orderTies(named).decidedBy, 'NAME_VS_TABLE');
  // Anonymised names (the name step cannot help): distinct ratio 0.74 vs 0.058 -> the closer-to-1 target wins by the cardinality step.
  const anonymous = [edge('t1.c1', 't2.k2', { sourceProfile: source, targetProfile: artist }), edge('t1.c1', 't3.k3', { sourceProfile: source, targetProfile: playlistTrack })];
  const cardinality = orderTies(anonymous);
  assert.equal(cardinality.decisive, true);
  assert.equal(cardinality.decidedBy, 'CARDINALITY_DISTINCT');
  assert.equal(cardinality.ordered[0]!.id, anonymous[0]!.id);
  // Anonymised and unmeasured: nothing separates -> NOT decisive, the sibling list is returned.
  const blind = [edge('t1.c1', 't2.k2'), edge('t1.c1', 't3.k3')];
  const open = orderTies(blind);
  assert.equal(open.decisive, false);
  assert.equal(open.decidedBy, null);
  assert.deepEqual(open.siblings, blind.map(item => item.id).sort((x, y) => x.localeCompare(y, 'en')));
  assert.match(open.reason, /^NOT_DECISIVE: /);
  assert.deepEqual(open.trace.map(item => item.outcome), ['EQUAL', 'SKIPPED_NOT_MEASURED', 'SKIPPED_NOT_MEASURED']);
});

test('TPCDS decoys (SYNTHETIC profiles, real names) lose to their true sibling: ss_store_sk -> web_site, ss_promo_sk -> reason, inv_warehouse_sk -> ship_mode', () => {
  const ss = prof(2880404, 12), inv = prof(11745000, 5);
  const store = edge('store_sales.ss_store_sk', 'store.s_store_sk', { sourceProfile: ss, targetProfile: prof(12, 12) });
  const webSite = edge('store_sales.ss_store_sk', 'web_site.web_site_sk', { sourceProfile: ss, targetProfile: prof(30, 30) });
  const first = orderTies([webSite, store]);
  assert.equal(first.decisive, true);
  assert.equal(first.ordered[0]!.id, store.id);
  assert.equal(first.decidedBy, 'NAME_VS_TABLE');

  const promo = edge('store_sales.ss_promo_sk', 'promotion.p_promo_sk', { sourceProfile: prof(2880404, 300), targetProfile: prof(300, 300) });
  const reason = edge('store_sales.ss_promo_sk', 'reason.r_reason_sk', { sourceProfile: prof(2880404, 300), targetProfile: prof(35, 35) });
  assert.equal(orderTies([reason, promo]).ordered[0]!.id, promo.id);

  const warehouse = edge('inventory.inv_warehouse_sk', 'warehouse.w_warehouse_sk', { sourceProfile: inv, targetProfile: prof(5, 5) });
  const shipMode = edge('inventory.inv_warehouse_sk', 'ship_mode.sm_ship_mode_sk', { sourceProfile: inv, targetProfile: prof(20, 20) });
  const third = orderTies([shipMode, warehouse]);
  assert.equal(third.ordered[0]!.id, warehouse.id);
  assert.equal(third.decisive, true);
});

test('role dimensions: ws_ship_date_sk -> date_dim beats -> time_dim by name even though both targets are single keys of similar size', () => {
  const src = prof(719384, 1933);
  const date = edge('web_sales.ws_ship_date_sk', 'date_dim.d_date_sk', { sourceProfile: src, targetProfile: prof(73049, 73049) });
  const time = edge('web_sales.ws_ship_date_sk', 'time_dim.t_time_sk', { sourceProfile: src, targetProfile: prof(86400, 86400) });
  const r = orderTies([time, date]);
  assert.equal(r.decisive, true);
  assert.equal(r.ordered[0]!.id, date.id);
});

test('cardinality: a target the source overshoots (distinct ratio above 1 + epsilon) loses; closer to 1 by a fold wins; row ratio is the next step; centrality decides nothing', () => {
  const src = prof(1000, 500);
  const over = edge('s.c', 'a.k', { sourceProfile: src, targetProfile: prof(100, 100) });
  const fit = edge('s.c', 'b.k', { sourceProfile: src, targetProfile: prof(900, 900) });
  const r = orderTies([over, fit]);
  assert.equal(r.decidedBy, 'CARDINALITY_DISTINCT');
  assert.equal(r.ordered[0]!.id, fit.id);

  // Distinct goodness 0.9 vs 0.6 is inside a fold: not separated by distinct; the row ratio (src table >= target table) then decides.
  const near = edge('s.c', 'a.k', { sourceProfile: prof(1000, 540), targetProfile: prof(600, 600) });
  const closer = edge('s.c', 'b.k', { sourceProfile: prof(1000, 540), targetProfile: prof(5000, 600) });
  const rows = orderTies([near, closer]);
  assert.equal(rows.trace[1]!.step, 'CARDINALITY_DISTINCT');
  assert.equal(rows.trace[1]!.outcome, 'EQUAL');
  assert.equal(rows.decidedBy, 'CARDINALITY_ROWS');
  assert.equal(rows.ordered[0]!.id, near.id);

  const equalA = edge('s.c', 'a.k', { sourceProfile: prof(100, 50), targetProfile: prof(100, 100) });
  const equalB = edge('s.c', 'b.k', { sourceProfile: prof(100, 50), targetProfile: prof(100, 100) });
  const other = edge('o.c', 'b.k');
  // Centrality is information only (replayed on TPCDS it picked the smallest hub 20 of 20 times, never the gold edge): b.k is referenced by two sources and still wins nothing.
  const central = orderTies([equalA, equalB], { candidates: [equalA, equalB, other] });
  assert.equal(central.decisive, false);
  assert.equal(central.decidedBy, null);
  assert.equal(measured(central.vectors.find(v => v.candidateId === equalB.id)!.targetCentrality), 2, 'still reported in the vector');
});

test('a step with a NOT_MEASURED input for any survivor is skipped and traced, never filled in', () => {
  const a = edge('s.c', 'a.k', { sourceProfile: prof(1000, 500), targetProfile: prof(900, 900) });
  const b = edge('s.c', 'b.k', { sourceProfile: prof(1000, 500) });
  const r = orderTies([a, b]);
  assert.equal(r.decisive, false);
  assert.deepEqual(r.trace.map(item => `${item.step}:${item.outcome}`), ['NAME_VS_TABLE:EQUAL', 'CARDINALITY_DISTINCT:SKIPPED_NOT_MEASURED', 'CARDINALITY_ROWS:SKIPPED_NOT_MEASURED']);
  assert.match(r.reason, /not measured: CARDINALITY_DISTINCT, CARDINALITY_ROWS/);
});

test('degenerate groups: a single candidate has no tie, an empty group is not decisive', () => {
  const only = edge('s.c', 'a.k');
  const one = orderTies([only]);
  assert.equal(one.decisive, true);
  assert.match(one.reason, /^NO_TIE/);
  assert.deepEqual(one.siblings, []);
  const none = orderTies([]);
  assert.equal(none.decisive, false);
  assert.deepEqual(none.ordered, []);
});

test('three siblings: when the top two stay tied the result is not decisive and the eliminated one is ordered last', () => {
  const a = edge('store_sales.ss_store_sk', 'store.s_store_sk'), b = edge('store_sales.ss_store_sk', 'store_dup.s_store_sk'), c = edge('store_sales.ss_store_sk', 'web_site.web_site_sk');
  const r = orderTies([c, b, a]);
  assert.equal(r.decisive, false);
  assert.deepEqual(r.siblings, [a.id, b.id].sort((x, y) => x.localeCompare(y, 'en')));
  assert.equal(r.ordered.at(-1)!.id, c.id);
});

test('the order is declared, deterministic and independent of input order; the input is not mutated', () => {
  assert.deepEqual([...TIE_STEP_ORDER], ['NAME_VS_TABLE', 'CARDINALITY_DISTINCT', 'CARDINALITY_ROWS']);
  const group = [edge('s.c', 'a.k', { sourceProfile: prof(10, 5), targetProfile: prof(5, 5) }), edge('s.c', 'b.k', { sourceProfile: prof(10, 5), targetProfile: prof(500, 500) }), edge('s.c', 'c.k')];
  const snapshot = JSON.stringify(group);
  const forward = orderTies(group), reversed = orderTies([...group].reverse());
  assert.deepEqual(forward.ordered.map(item => item.id), reversed.ordered.map(item => item.id));
  assert.equal(forward.reason, reversed.reason);
  assert.equal(JSON.stringify(group), snapshot);
});

test('weakestOf names the weakest edge under the same steps and says when two are tied', () => {
  const strong = edge('store_returns.sr_store_sk', 'store.s_store_sk', { sourceProfile: prof(287514, 12), targetProfile: prof(12, 12) });
  const weak = edge('store.s_store_sk', 'store_returns.sr_store_sk', { sourceProfile: prof(12, 12), targetProfile: prof(287514, 12) });
  const w = weakestOf([strong, weak]);
  assert.equal(w.decisive, true);
  assert.equal(w.survivors[0]!.id, weak.id);
  assert.equal(w.decidedBy, 'CARDINALITY_ROWS');
  const tied = weakestOf([edge('s.c', 'a.k'), edge('s.c', 'b.k')]);
  assert.equal(tied.decisive, false);
  assert.equal(tied.survivors.length, 2);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- E2-07

test('derived copies (E2-07): equal rows and containment of about 1 in both directions are flagged as a feature; one-sided containment, different rows and the same table are not', () => {
  const profiles: Record<string, ProfileLike> = {
    'customer.c_customer_sk': prof(100000, 100000), 'customer_copy.c_customer_sk': prof(100000, 100000), 'orders.customer_sk': prof(100000, 5000),
    'item.i_item_sk': prof(18000, 18000), 'item_slim.i_item_sk': prof(9000, 9000), 'x.k': { provenance: 'NOT_MEASURED', reason: 'QUERY_FAILED' },
  };
  const result = detectDerivedCopies(profiles, [
    { a: 'customer_copy.c_customer_sk', b: 'customer.c_customer_sk', aInB: 1, bInA: 0.999 },
    { a: 'orders.customer_sk', b: 'customer.c_customer_sk', aInB: 1, bInA: 0.05 },
    { a: 'item.i_item_sk', b: 'item_slim.i_item_sk', aInB: 0.5, bInA: 1 },
    { a: 'customer.c_customer_sk', b: 'customer.c_customer_sk', aInB: 1, bInA: 1 },
    { a: 'x.k', b: 'item.i_item_sk', aInB: 1, bInA: 1 },
    { a: 'item.i_item_sk', b: 'customer.c_customer_sk', aInB: null, bInA: 0 },
  ]);
  assert.deepEqual(result.copies, [{ a: 'customer.c_customer_sk', b: 'customer_copy.c_customer_sk', rows: 100000, aInB: 0.999, bInA: 1, reason: 'DERIVED_COPY_EQUAL_ROWS_MUTUAL_CONTAINMENT' }]);
  assert.deepEqual(result.notMeasured.map(item => `${item.a}|${item.b}|${item.reason}`), ['customer.c_customer_sk|item.i_item_sk|CONTAINMENT_NOT_MEASURED', 'item.i_item_sk|x.k|PROFILE_NOT_MEASURED:x.k']);
});

test('purity: the two modules import nothing that reads files, runs SQL or calls a model', () => {
  for (const file of ['../src/agent/tie-break.ts', '../src/agent/consistency.ts']) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1]);
    assert.deepEqual(imports.filter(spec => spec !== './tie-break.ts'), [], file);
    assert.doesNotMatch(source, /process\.env|readFile|writeFile|fetch\(|runSql|eval-labels/);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- abbreviations and the hub

test('abbreviations: cdemo / hdemo / addr / cust expand through the closed, versioned map and the entry that fired is reported', () => {
  const score = (from: string, to: string) => { const v = tieBreakVector(edge(from, to)); return { n: measured(v.nameVsTable), fired: v.nameExpansions.map(item => `${item.side}:${item.token}`) }; };
  assert.deepEqual(score('store_sales.ss_cdemo_sk', 'customer_demographics.cd_demo_sk'), { n: 2, fired: ['SOURCE:cdemo'] });
  assert.deepEqual(score('store_sales.ss_cdemo_sk', 'household_demographics.hd_demo_sk'), { n: 1, fired: ['SOURCE:cdemo'] });
  assert.deepEqual(score('store_sales.ss_hdemo_sk', 'household_demographics.hd_demo_sk'), { n: 2, fired: ['SOURCE:hdemo'] });
  assert.deepEqual(score('store_sales.ss_hdemo_sk', 'income_band.ib_income_band_sk'), { n: 0, fired: ['SOURCE:hdemo'] });
  assert.deepEqual(score('orders.cust_id', 'customers.id'), { n: 1, fired: ['SOURCE:cust'] });
  assert.deepEqual(score('web_sales.ws_bill_addr_sk', 'customer_address.ca_address_sk'), { n: 1, fired: ['SOURCE:addr'] });
  assert.deepEqual(score('store_sales.ss_store_sk', 'store.s_store_sk'), { n: 1, fired: [] }, 'no entry fires on a plain name');
  assert.equal(NAME_ABBREVIATIONS.version, 'abbr-v1');
  assert.ok(!('demo' in NAME_ABBREVIATIONS.entries), 'closed map: exact keys only');
  assert.equal(tieBreakVector(edge('a.constructor', 'b.k')).nameExpansions.length, 0, 'prototype names never expand');
});

test('the hub regression (Round 10 A/B, open item 7): cdemo siblings resolve to customer_demographics by name, never to the most referenced small table', () => {
  const src = prof(2880404, 1920800);
  const cd = edge('store_sales.ss_cdemo_sk', 'customer_demographics.cd_demo_sk', { sourceProfile: src, targetProfile: prof(1920800, 1920800) });
  const hd = edge('store_sales.ss_cdemo_sk', 'household_demographics.hd_demo_sk', { sourceProfile: src, targetProfile: prof(7200, 7200) });
  const hub = edge('store_sales.ss_cdemo_sk', 'income_band.ib_income_band_sk', { sourceProfile: src, targetProfile: prof(20, 20) });
  // SYNTHETIC crowd of other sources that all overlap the small hub: the hub is the most central target of the set.
  const crowd = Array.from({ length: 12 }, (_, i) => edge(`t${i}.fk_sk`, 'income_band.ib_income_band_sk'));
  const result = orderTies([hub, hd, cd], { candidates: [cd, hd, hub, ...crowd] });
  assert.equal(result.decisive, true);
  assert.equal(result.decidedBy, 'NAME_VS_TABLE');
  assert.equal(result.ordered[0]!.id, cd.id);
  assert.ok(measured(result.vectors.find(v => v.candidateId === hub.id)!.targetCentrality) > measured(result.vectors.find(v => v.candidateId === cd.id)!.targetCentrality), 'the hub is the most central, and that decides nothing');
});

test('when the name cannot separate the siblings (same target table, two columns) and nothing is measured, the tie stays deferred even if one target is a hub', () => {
  const a = edge('store_sales.ss_hdemo_sk', 'household_demographics.hd_demo_sk'), b = edge('store_sales.ss_hdemo_sk', 'household_demographics.hd_income_band_sk');
  const crowd = Array.from({ length: 5 }, (_, i) => edge(`t${i}.fk_sk`, 'household_demographics.hd_income_band_sk'));
  const result = orderTies([a, b], { candidates: [a, b, ...crowd] });
  assert.equal(result.decisive, false);
  assert.deepEqual(result.siblings, [a.id, b.id].sort((x, y) => x.localeCompare(y, 'en')));
});
