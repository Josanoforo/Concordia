import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { enforceConsistency, type ConsistencyEdge } from '../src/agent/consistency.ts';
import { orderTies } from '../src/agent/tie-break.ts';

/**
 * Round 10 / X10 OFFLINE EVALUATION. The gold (tests/fixtures/round9/eval-labels.json) appears only here, as a comparison after the fact; nothing in src/ reads it and the functions under
 * test take no label. Input: the HIGH, unsuspected candidates of the real TPCDS live-04 run (names only; that fixture carries no whole-table profiles), plus the three decoys and,
 * where the run did not have it, a SYNTHETIC true sibling (labeled below).
 */
const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const gold = read('./fixtures/round9/eval-labels.json') as { yes: string[]; deferred: { id: string }[]; decoys: { id: string }[] };
const run = read('./fixtures/agent-runs/agent-tpcds-live-04/engine-run.json');

const fromProposal = (proposal: any): ConsistencyEdge => ({ id: proposal.proposalId, from: proposal.from, to: proposal.to, reachesHigh: true });
const highUnsuspected: ConsistencyEdge[] = run.postComa.proposals
  .filter((p: any) => p.coverageProbe.status === 'EXECUTED' && p.coverageProbe.diagnostic.coverage.level === 'HIGH' && !p.coverageProbe.diagnostic.suspect.value).map(fromProposal);
const decoyEdge = (id: string): ConsistencyEdge => {
  const [from, to] = id.split('__'), [fromTable, fromColumn] = from!.split('.'), [toTable, toColumn] = to!.split('.');
  return { id, from: { db: 'TPCDS_DB', table: fromTable!, column: fromColumn! }, to: { db: 'TPCDS_DB', table: toTable!, column: toColumn! }, reachesHigh: true };
};
/** SYNTHETIC: the true sibling of the ss_promo_sk decoy; the live-04 run probed cs_promo_sk and ws_promo_sk but not ss_promo_sk. */
const syntheticPromo: ConsistencyEdge = decoyEdge('store_sales.ss_promo_sk__promotion.p_promo_sk');

test('eval: on the real live-04 HIGH set the pass demotes nothing (28 candidates, 0 gold-yes or deferred edges lost, role dimensions and shared targets untouched)', () => {
  assert.equal(highUnsuspected.length, 28, '30 executed candidates, 2 suspected (TARGET_NOT_UNIQUE): 28 HIGH unsuspected');
  const result = enforceConsistency(highUnsuspected);
  assert.deepEqual(result.demoted, []);
  assert.deepEqual(result.unresolved, []);
  const keptIds = new Set(result.kept.map(item => item.id));
  const known = [...gold.yes, ...gold.deferred.map(item => item.id)].filter(id => highUnsuspected.some(item => item.id === id));
  assert.ok(known.length >= 25);
  for (const id of known) assert.ok(keptIds.has(id), `${id} survives`);
});

test('eval: with the three gold decoys added, every decoy is demoted by FK_ONCE in favour of its true sibling and no gold-yes or deferred edge is touched', () => {
  const decoys = gold.decoys.map(item => decoyEdge(item.id));
  const result = enforceConsistency([...highUnsuspected, syntheticPromo, ...decoys]);
  assert.deepEqual(result.demoted.map(item => item.edge.id).sort(), gold.decoys.map(item => item.id).sort());
  assert.ok(result.demoted.every(item => item.rule === 'FK_ONCE' && item.winner !== null));
  const goldAll = new Set([...gold.yes, ...gold.deferred.map(item => item.id)]);
  assert.deepEqual(result.demoted.filter(item => goldAll.has(item.edge.id)), []);
  assert.deepEqual(Object.fromEntries(result.demoted.map(item => [item.edge.id.split('__')[1], item.winner!.split('__')[1]])), {
    'web_site.web_site_sk': 'store.s_store_sk', 'ship_mode.sm_ship_mode_sk': 'warehouse.w_warehouse_sk', 'reason.r_reason_sk': 'promotion.p_promo_sk',
  });
  assert.equal(result.unresolved.length, 0);
});

test('eval: the tie-break alone separates each decoy from its true sibling by name against the target table (decisive, 3/3)', () => {
  const byId = new Map([...highUnsuspected, syntheticPromo, ...gold.decoys.map(item => decoyEdge(item.id))].map(item => [item.id, item]));
  const pairs: [string, string][] = [
    ['store_sales.ss_store_sk__web_site.web_site_sk', 'store_sales.ss_store_sk__store.s_store_sk'],
    ['inventory.inv_warehouse_sk__ship_mode.sm_ship_mode_sk', 'inventory.inv_warehouse_sk__warehouse.w_warehouse_sk'],
    ['store_sales.ss_promo_sk__reason.r_reason_sk', 'store_sales.ss_promo_sk__promotion.p_promo_sk'],
  ];
  for (const [decoy, truth] of pairs) {
    const result = orderTies([byId.get(decoy)!, byId.get(truth)!]);
    assert.equal(result.decisive, true, decoy);
    assert.equal(result.decidedBy, 'NAME_VS_TABLE');
    assert.equal(result.ordered[0]!.id, truth);
  }
});
