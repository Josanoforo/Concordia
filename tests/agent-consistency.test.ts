import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceConsistency, type ConsistencyEdge } from '../src/agent/consistency.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import type { ProfileLike } from '../src/agent/tie-break.ts';

/**
 * Round 10 / X10 (E2-03): the global consistency post-pass over approved edges. Offline, pure, no gold.
 * Fixture provenance: names are real (TPCDS columns, Chinook/NWCH, a taxi-style schema); every profile is SYNTHETIC (hand-written, illustrative scale, NOT a measurement), except the NWCH
 * test that takes its profiles from the in-repo offline fixture rows.
 */
const prof = (rows: number, distinct: number): ProfileLike => ({ provenance: 'GLOBAL_WHOLE_TABLE', rows, distinct, nulls: 0 });
const edge = (from: string, to: string, extra: Partial<ConsistencyEdge> = {}): ConsistencyEdge => {
  const [fromTable, fromColumn] = from.split('.'), [toTable, toColumn] = to.split('.');
  return { id: `${from}__${to}`, from: { table: fromTable!, column: fromColumn! }, to: { table: toTable!, column: toColumn! }, ...extra };
};
const ids = (edges: readonly { id: string }[]): string[] => edges.map(item => item.id).sort((a, b) => a.localeCompare(b, 'en'));

test('role dimensions are different source columns: sold/ship date -> date_dim and sold time -> time_dim are all kept by FK_ONCE', () => {
  const edges = [
    edge('web_sales.ws_sold_date_sk', 'date_dim.d_date_sk'), edge('web_sales.ws_ship_date_sk', 'date_dim.d_date_sk'), edge('web_sales.ws_sold_time_sk', 'time_dim.t_time_sk'),
    edge('store_sales.ss_sold_date_sk', 'date_dim.d_date_sk'), edge('catalog_sales.cs_sold_date_sk', 'date_dim.d_date_sk'), edge('catalog_sales.cs_ship_date_sk', 'date_dim.d_date_sk'),
  ];
  const result = enforceConsistency(edges);
  assert.deepEqual(result.demoted, []);
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.kept.map(item => item.id), edges.map(item => item.id), 'input order is preserved');
});

test('pickup and dropoff to the same zone table are two source columns of one table pair and both stay (no "one FK per table pair" rule)', () => {
  const edges = [edge('trips.PULocationID', 'zones.LocationID'), edge('trips.DOLocationID', 'zones.LocationID')];
  const result = enforceConsistency(edges);
  assert.equal(result.kept.length, 2);
  assert.deepEqual(result.demoted, []);
});

test('decoys lose to the true sibling of the same source column: ss_store_sk -> web_site, ss_promo_sk -> reason, inv_warehouse_sk -> ship_mode (FK_ONCE, winner named)', () => {
  const store = edge('store_sales.ss_store_sk', 'store.s_store_sk'), webSite = edge('store_sales.ss_store_sk', 'web_site.web_site_sk');
  const promo = edge('store_sales.ss_promo_sk', 'promotion.p_promo_sk'), reason = edge('store_sales.ss_promo_sk', 'reason.r_reason_sk');
  const warehouse = edge('inventory.inv_warehouse_sk', 'warehouse.w_warehouse_sk'), shipMode = edge('inventory.inv_warehouse_sk', 'ship_mode.sm_ship_mode_sk');
  const result = enforceConsistency([webSite, store, reason, promo, shipMode, warehouse]);
  assert.deepEqual(ids(result.kept), ids([store, promo, warehouse]));
  assert.deepEqual(result.demoted.map(item => [item.edge.id, item.rule, item.winner]).sort(), [
    [reason.id, 'FK_ONCE', promo.id], [shipMode.id, 'FK_ONCE', warehouse.id], [webSite.id, 'FK_ONCE', store.id],
  ].sort());
  for (const item of result.demoted) assert.match(item.reason, /^FK_ONCE: .* demoted in favour of .*DECIDED_BY_NAME_VS_TABLE/);
});

test('NWCH tie as approved edges (fixture rows): artist stays, playlist_track.TrackId is demoted with the winner', () => {
  const fixture = structuredClone(agentFixtures().find(item => item.alias === 'NWCH')!);
  const profile = (table: string, column: string): ProfileLike => {
    const t = (fixture.tables as any)[table], index = t.columns.findIndex((c: any) => c.name === column), values = t.rows.map((row: unknown[]) => row[index]);
    return { provenance: 'GLOBAL_WHOLE_TABLE', rows: values.length, distinct: new Set(values).size, nulls: 0 };
  };
  const src = profile('chinook_album', 'ArtistId');
  const keep = edge('chinook_album.ArtistId', 'chinook_artist.ArtistId', { sourceProfile: src, targetProfile: profile('chinook_artist', 'ArtistId') });
  const drop = edge('chinook_album.ArtistId', 'chinook_playlist_track.TrackId', { sourceProfile: src, targetProfile: profile('chinook_playlist_track', 'TrackId') });
  const result = enforceConsistency([drop, keep]);
  assert.deepEqual(result.kept.map(item => item.id), [keep.id]);
  assert.equal(result.demoted[0]!.edge.id, drop.id);
  assert.equal(result.demoted[0]!.winner, keep.id);
});

test('a declared alias lets one source column keep several targets; without it the weaker one is demoted', () => {
  const edges = [edge('orders.customer_id', 'customers.id'), edge('orders.customer_id', 'accounts.id')];
  assert.equal(enforceConsistency(edges).demoted.length, 1);
  const aliased = enforceConsistency(edges, { aliases: [{ source: 'orders.customer_id', targets: ['customers.id', 'accounts'] }] });
  assert.equal(aliased.kept.length, 2);
  assert.deepEqual(aliased.demoted, []);
  // Only the aliased pair is exempt: the other competitor still loses to customers.
  const partial = enforceConsistency([...edges, edge('orders.customer_id', 'crm.customer_id')], { aliases: [{ source: 'orders.customer_id', targets: ['accounts.id'] }] });
  assert.deepEqual(ids(partial.kept), ids([edges[0]!, edges[1]!]));
  assert.equal(partial.demoted[0]!.edge.to.table, 'crm');
});

test('siblings the declared steps cannot separate are all kept and reported unresolved (nothing is dropped on a coin flip)', () => {
  const a = edge('t1.c1', 't2.k2'), b = edge('t1.c1', 't3.k3');
  const result = enforceConsistency([a, b]);
  assert.deepEqual(ids(result.kept), ids([a, b]));
  assert.deepEqual(result.demoted, []);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0]!.rule, 'FK_ONCE');
  assert.deepEqual(result.unresolved[0]!.edges, ids([a, b]));
  assert.match(result.unresolved[0]!.reason, /^NOT_DECISIVE/);
});

test('2-cycle: the reverse edge of store_returns.sr_store_sk -> store.s_store_sk is demoted (CYCLE) and the forward edge is the winner', () => {
  const forward = edge('store_returns.sr_store_sk', 'store.s_store_sk', { sourceProfile: prof(287514, 12), targetProfile: prof(12, 12) });
  const reverse = edge('store.s_store_sk', 'store_returns.sr_store_sk', { sourceProfile: prof(12, 12), targetProfile: prof(287514, 12) });
  const result = enforceConsistency([reverse, forward]);
  assert.deepEqual(result.kept.map(item => item.id), [forward.id]);
  assert.equal(result.demoted.length, 1);
  assert.equal(result.demoted[0]!.rule, 'CYCLE');
  assert.equal(result.demoted[0]!.edge.id, reverse.id);
  assert.equal(result.demoted[0]!.winner, forward.id);
  assert.match(result.demoted[0]!.reason, /decided by CARDINALITY_ROWS/);
  // Names alone also orient it: orders.customer_id -> customers.id over customers.id -> orders.customer_id.
  const byName = enforceConsistency([edge('customers.id', 'orders.customer_id'), edge('orders.customer_id', 'customers.id')]);
  assert.deepEqual(byName.kept.map(item => item.id), ['orders.customer_id__customers.id']);
  assert.equal(byName.demoted[0]!.rule, 'CYCLE');
});

test('a longer cycle is broken at its weakest edge; a cycle the steps cannot break stays whole and is reported', () => {
  const same = { distinct: 100 };
  const line = edge('line.k', 'order.k', { sourceProfile: prof(1000, same.distinct), targetProfile: prof(100, same.distinct) });
  const order = edge('order.k', 'cust.k', { sourceProfile: prof(100, same.distinct), targetProfile: prof(10, same.distinct) });
  const cust = edge('cust.k', 'line.k', { sourceProfile: prof(10, same.distinct), targetProfile: prof(1000, same.distinct) });
  const result = enforceConsistency([line, order, cust]);
  assert.deepEqual(ids(result.kept), ids([line, order]));
  assert.equal(result.demoted[0]!.edge.id, cust.id);
  assert.equal(result.demoted[0]!.rule, 'CYCLE');
  assert.equal(result.demoted[0]!.winner, null, 'the two edges left do not separate, so no single winner is named');

  const blind = enforceConsistency([edge('a.k', 'b.k'), edge('b.k', 'c.k'), edge('c.k', 'a.k')]);
  assert.equal(blind.kept.length, 3);
  assert.equal(blind.demoted.length, 0);
  assert.equal(blind.unresolved.length, 1);
  assert.equal(blind.unresolved[0]!.rule, 'CYCLE');
});

test('cycles are over COLUMNS: a table-level loop through different columns is legitimate and stays (the schema is not assumed to be a tree)', () => {
  const edges = [edge('employee.dept_id', 'department.id'), edge('department.manager_id', 'employee.id')];
  const result = enforceConsistency(edges);
  assert.equal(result.kept.length, 2);
  assert.deepEqual(result.demoted, []);
  assert.deepEqual(result.unresolved, []);
});

test('TRANSITIVE: S -> B, B -> A and S -> A with no evidence between the two edges of S: both stay and the conflict is reported (centrality decides nothing)', () => {
  const sb = edge('shipment.order_id', 'order_detail.order_id'), ba = edge('order_detail.order_id', 'orders.order_id'), sa = edge('shipment.order_id', 'orders.order_id');
  const result = enforceConsistency([sb, ba, sa]);
  assert.deepEqual(ids(result.kept), ids([sb, ba, sa]));
  assert.deepEqual(result.demoted, []);
  assert.deepEqual(result.unresolved.map(item => item.rule), ['TRANSITIVE']);
  assert.deepEqual(result.unresolved[0]!.edges, ids([sb, sa]));
});

test('TRANSITIVE: when the evidence distinguishes the two edges of S it separates them (name or cardinality)', () => {
  const src = prof(2000, 500);
  const sb = edge('shipment.order_id', 'order_detail.order_id', { sourceProfile: src, targetProfile: prof(2000, 480) });
  const ba = edge('order_detail.order_id', 'orders.order_id', { sourceProfile: prof(2000, 480), targetProfile: prof(5000, 5000) });
  const sa = edge('shipment.order_id', 'orders.order_id', { sourceProfile: src, targetProfile: prof(5000, 5000) });
  const result = enforceConsistency([sa, ba, sb]);
  assert.deepEqual(ids(result.kept), ids([sb, ba]));
  assert.equal(result.demoted[0]!.rule, 'TRANSITIVE');
  assert.equal(result.demoted[0]!.edge.id, sa.id);
  assert.match(result.demoted[0]!.reason, /DECIDED_BY_CARDINALITY_DISTINCT/);
});

test('a declared alias also exempts the pair from TRANSITIVE', () => {
  const edges = [edge('shipment.order_id', 'order_detail.order_id'), edge('order_detail.order_id', 'orders.order_id'), edge('shipment.order_id', 'orders.order_id')];
  const result = enforceConsistency(edges, { aliases: [{ source: 'shipment.order_id', targets: ['order_detail.order_id', 'orders.order_id'] }] });
  assert.equal(result.kept.length, 3);
});

test('empty and single-edge inputs, and duplicate ids', () => {
  assert.deepEqual(enforceConsistency([]), { kept: [], demoted: [], unresolved: [] });
  const one = edge('a.x', 'b.y');
  assert.deepEqual(enforceConsistency([one]).kept, [one]);
  assert.throws(() => enforceConsistency([one, { ...one }]), /CONSISTENCY_DUPLICATE_EDGE_ID/);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------- invariants

/** Deterministic pseudo-random graphs (LCG, fixed seeds). SYNTHETIC. */
function graph(seed: number): ConsistencyEdge[] {
  let state = seed;
  const next = (n: number): number => { state = (state * 1103515245 + 12345) % 2147483648; return state % n; };
  const tables = ['alpha', 'beta', 'gamma', 'delta', 'omega'], columns = ['id', 'beta_id', 'gamma_id', 'ref'];
  const out = new Map<string, ConsistencyEdge>();
  for (let index = 0; index < 8 + next(8); index++) {
    const from = `${tables[next(5)]}.${columns[next(4)]}`, to = `${tables[next(5)]}.${columns[next(4)]}`;
    if (from === to) continue;
    const withProfile = next(2) === 0;
    out.set(`${from}__${to}`, edge(from, to, withProfile ? { sourceProfile: prof(10 + next(1000), 1 + next(100)), targetProfile: prof(10 + next(1000), 1 + next(100)) } : {}));
  }
  return [...out.values()];
}
const hasColumnCycle = (edges: readonly ConsistencyEdge[]): boolean => {
  const key = (e: { table: string; column: string }) => `${e.table}.${e.column}`, adj = new Map<string, Set<string>>();
  for (const e of edges) adj.set(key(e.from), new Set([...(adj.get(key(e.from)) ?? []), key(e.to)]));
  const reach = (start: string): Set<string> => { const seen = new Set<string>(), stack = [...(adj.get(start) ?? [])]; while (stack.length) { const n = stack.pop()!; if (!seen.has(n)) { seen.add(n); stack.push(...(adj.get(n) ?? [])); } } return seen; };
  return [...adj.keys()].some(n => reach(n).has(n));
};

test('invariants over 200 synthetic graphs: kept and demoted partition the input, input order does not matter, and what remains inconsistent is exactly what was reported unresolved', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const edges = graph(seed * 7919);
    const result = enforceConsistency(edges);
    assert.deepEqual([...ids(result.kept), ...ids(result.demoted.map(item => item.edge))].sort(), ids(edges), `partition, seed ${seed}`);
    for (const item of result.demoted) { assert.ok(item.winner === null || edges.some(e => e.id === item.winner), 'winner is an input edge'); assert.ok(item.reason.length > 0); }
    const shuffled = enforceConsistency([...edges].reverse());
    assert.deepEqual(ids(shuffled.kept), ids(result.kept), `order independence, seed ${seed}`);
    const fkOnceOpen = new Map<string, string[]>();
    for (const e of result.kept) { const k = `${e.from.table}.${e.from.column}`; fkOnceOpen.set(k, [...(fkOnceOpen.get(k) ?? []), e.id]); }
    for (const group of fkOnceOpen.values()) if (group.length > 1) assert.ok(result.unresolved.some(u => group.filter(id => u.edges.includes(id)).length > 1), `FK_ONCE leftover is reported, seed ${seed}`);
    const reportedCycleEdges = new Set(result.unresolved.filter(u => u.rule === 'CYCLE').flatMap(u => u.edges));
    assert.equal(hasColumnCycle(result.kept.filter(e => !reportedCycleEdges.has(e.id))), false, `no unreported column cycle, seed ${seed}`);
  }
});
