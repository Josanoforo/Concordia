import test from 'node:test';
import assert from 'node:assert/strict';
import { runPostComa } from '../src/agent/post-coma.ts';
import { validateExplorationCatalog } from '../src/agent/catalog.ts';
import { RunBudget, budgetedClient, limitsFromBounds } from '../src/agent/run-budget.ts';

// A minimal TPC-DS-shaped universe with NO configured relations: true foreign keys plus homonymous traps.
const col = (name: string) => ({ name, type: 'string' });
const tables: Record<string, { cols: string[]; labels: string[]; rows: string[][] }> = {
  ds_sales: { cols: ['item_sk', 'store_sk', 'ticket_sk'], labels: [], rows: [['1', '1', '900'], ['2', '2', '901'], ['3', '3', '902'], ['4', '1', '903']] },
  ds_returns: { cols: ['item_sk', 'ticket_sk'], labels: [], rows: [['1', '100'], ['2', '101'], ['3', '102']] },
  ds_item: { cols: ['i_item_sk', 'i_name'], labels: ['i_name'], rows: [['1', 'Widget'], ['2', 'Gadget'], ['3', 'Gizmo'], ['4', 'Doohickey']] },
  ds_store: { cols: ['s_store_sk', 's_name'], labels: ['s_name'], rows: [['1', 'Downtown'], ['2', 'Harbor'], ['3', 'Airport']] },
  ds_warehouse: { cols: ['w_warehouse_sk', 'w_name'], labels: ['w_name'], rows: [['1', 'North Depot'], ['2', 'South Depot'], ['3', 'East Depot']] }
};
const cfg: any = { tables: Object.fromEntries(Object.entries(tables).map(([name, t]) => [name, { db: 'TPC', physicalTable: name, columns: t.cols.map(col), keyColumns: [], labels: t.labels, role: 'table' }])) };
const discovery = { tables: Object.fromEntries(Object.entries(tables).map(([name, t]) => [name, { columns: t.cols, sample: { rows: t.rows } }])) };
const prop = (ft: string, fc: string, tt: string, tc: string, rawScore: number) => ({ providerId: 'p', providerVersion: '1', method: 'COMA', from: { db: 'TPC', table: ft, column: fc }, to: { db: 'TPC', table: tt, column: tc }, rawScore,
  reason: 'COMA_COLUMN_PAIR_OUT_OF_SCOPE', verificationStatus: 'NO VERIFICADO/UNKNOWN' as const, reviewState: 'PENDING' as const, inputHash: 'h', configHash: 'c', evidenceRefs: [] });
const proposals = [
  prop('ds_sales', 'item_sk', 'ds_item', 'i_item_sk', 0.9),          // true FK
  prop('ds_item', 'i_item_sk', 'ds_sales', 'item_sk', 0.88),         // same pair, other direction
  prop('ds_sales', 'ticket_sk', 'ds_returns', 'ticket_sk', 0.85),    // homonym: no common values
  prop('ds_store', 's_store_sk', 'ds_warehouse', 'w_warehouse_sk', 0.8), // homonym: same keys, different meaning
  prop('ds_sales', 'store_sk', 'ds_store', 's_store_sk', 0.7)        // true FK
];
const thresholds = { sustainedOverlap: 0.8, sustainedLabelAgreement: 0.8, misleadingLabelAgreement: 0.5 };
function fakeClient() {
  const log: string[] = [];
  return { log, async runSql(sql: string, limit = 50) {
    log.push(sql);
    const name = Object.keys(tables).find(n => new RegExp(`\\b${n}\\b`).test(sql))!, t = tables[name];
    const select = /^SELECT (.+?) FROM /s.exec(sql)![1].split(',').map(x => x.trim().replace(/`/g, ''));
    const where = /WHERE (\w+) IN \(([^)]*)\)/.exec(sql)!, values = [...where[2].matchAll(/'([^']*)'/g)].map(m => m[1]), at = t.cols.indexOf(where[1]);
    const rows = t.rows.filter(row => values.includes(row[at])).slice(0, limit).map(row => select.map(c => row[t.cols.indexOf(c)]));
    return { sql, rows, requestId: `r${log.length}`, queryId: `q${log.length}`, durationMs: 0, utc: 'x' };
  } };
}
const run = (postComa: any, limits = {}) => { const client = fakeClient(), budget = new RunBudget(limitsFromBounds(limits)); return runPostComa({ cfg, catalog: { postComa } as any, discovery, proposals, client: budgetedClient(client as any, budget) as any, budget, thresholds }).then(report => ({ report, client })); };
const byId = (report: any) => Object.fromEntries(report.proposals.map((p: any) => [p.proposalId, p]));

test('P3: with no configured relations, true FKs get high coverage and homonyms are marked suspect', async () => {
  const { report } = await run({ maxProbes: 10, blind: true });
  const p = byId(report);
  assert.equal(report.proposals.length, 4, 'a pair proposed in both directions is probed once');
  const fk = p['ds_sales.item_sk__ds_item.i_item_sk'].coverageProbe.diagnostic;
  assert.deepEqual({ level: fk.coverage.level, m: fk.coverage.matched, n: fk.coverage.probed, suspect: fk.suspect.value, labels: fk.labels.signal }, { level: 'HIGH', m: 4, n: 4, suspect: false, labels: 'NOT_COMPARABLE' });
  assert.equal(fk.keyRules.targetUniqueness.status, 'NO_DUPLICATES_IN_SAMPLE');
  assert.equal(fk.containment.reason, 'TARGET_FILTERED_BY_SOURCE_KEYS');
  assert.equal(fk.multiplicity.from.maxRowsPerKey, 1);
  assert.match(fk.counterfactual, /candidata para revision humana/);
  const store = p['ds_sales.store_sk__ds_store.s_store_sk'].coverageProbe.diagnostic;
  assert.equal(store.coverage.level, 'HIGH');
  assert.equal(store.suspect.value, false);
  const noCoverage = p['ds_sales.ticket_sk__ds_returns.ticket_sk'].coverageProbe;
  assert.equal(noCoverage.status, 'EXECUTED');
  assert.deepEqual({ level: noCoverage.diagnostic.coverage.level, reasons: noCoverage.diagnostic.suspect.reasons }, { level: 'NONE', reasons: ['NO_COVERAGE'] });
  const trap = p['ds_store.s_store_sk__ds_warehouse.w_warehouse_sk'].coverageProbe.diagnostic;
  assert.deepEqual({ signal: trap.labels.signal, agree: trap.labels.agree, compared: trap.labels.compared, coverage: trap.coverage.level, reasons: trap.suspect.reasons }, { signal: 'LABEL_CONFLICT', agree: 0, compared: 3, coverage: 'HIGH', reasons: ['LABEL_CONFLICT'] });
  assert.match(trap.counterfactual, /3 de 3/);
  assert.match(trap.counterfactual, /0\.8/);
});

test('P3: candidates stay unverified and pending; nothing produces a verdict', async () => {
  const { report } = await run({ maxProbes: 10, blind: true });
  for (const item of report.proposals) {
    assert.equal(item.verificationStatus, 'NO VERIFICADO/UNKNOWN');
    assert.equal(item.reviewState, 'PENDING');
    assert.ok(!('verdict' in item) && !JSON.stringify(item).includes('"verdict"'));
    assert.equal(item.coverageProbe.diagnostic!.governance, 'CANDIDATE_REQUIRES_REVIEW');
  }
});

test('P3: the probe cap and the query budget leave a ranked list of what was not executed', async () => {
  const capped = await run({ maxProbes: 2, blind: true });
  assert.deepEqual(capped.report.proposals.filter((p: any) => p.coverageProbe.status === 'EXECUTED').map((p: any) => p.proposalId), ['ds_sales.item_sk__ds_item.i_item_sk', 'ds_sales.ticket_sk__ds_returns.ticket_sk']);
  assert.deepEqual(capped.report.notExecutedByBudget.map((x: any) => [x.proposalId, x.reason]), [['ds_store.s_store_sk__ds_warehouse.w_warehouse_sk', 'NOT_SELECTED_MAX_PROBES'], ['ds_sales.store_sk__ds_store.s_store_sk', 'NOT_SELECTED_MAX_PROBES']]);
  assert.ok(capped.report.notExecutedByBudget[0].rawScore >= capped.report.notExecutedByBudget[1].rawScore);
  const broke = await run({ maxProbes: 10, blind: true }, { maxQueriesPerRun: 1 });
  assert.equal(broke.report.counts.executed, 1);
  assert.equal(broke.report.counts.skippedBudget, 3);
  assert.equal(broke.report.status, 'PARTIAL');
  assert.deepEqual(new Set(broke.report.notExecutedByBudget.map((x: any) => x.reason)), new Set(['QUERY_BUDGET_INSUFFICIENT']));
});

test('P3: the label columns are only added to the SQL when both sides declare comparable labels', async () => {
  const { client } = await run({ maxProbes: 10, blind: true });
  assert.ok(client.log.some(sql => /^SELECT s_store_sk, s_name FROM|^SELECT w_warehouse_sk, w_name FROM/.test(sql)));
  assert.ok(client.log.some(sql => /^SELECT i_item_sk FROM/.test(sql)), 'one-sided labels are not projected');
  assert.ok(client.log.every(sql => /LIMIT 50$/.test(sql) && !/address|email/.test(sql)));
});

test('P3: blind mode raises the probe ceiling to 40 and leaves the default ceiling at 5', () => {
  const base: any = { tables: cfg.tables, explorationCatalog: { productLabel: 'TPC', plannerTask: 'blind discovery', observations: { K: { fromTable: 'ds_item', column: 'i_item_sk', pattern: '^[0-9]+$' } }, actions: [{ id: 'PROFILE_ITEM', kind: 'BOUNDED_PROFILE', table: 'ds_item', filterColumn: 'i_item_sk' }] } };
  const codes = (postComa: any) => validateExplorationCatalog({ ...base, explorationCatalog: { ...base.explorationCatalog, postComa } }, 'x').map(i => i.code);
  assert.deepEqual(codes({ maxProbes: 30, blind: true }), []);
  assert.deepEqual(codes({ maxProbes: 41, blind: true }), ['INVALID_POST_COMA_POLICY']);
  assert.deepEqual(codes({ maxProbes: 9 }), ['INVALID_POST_COMA_POLICY']);
  assert.deepEqual(codes({ maxProbes: 3, blind: 'yes' }), ['INVALID_POST_COMA_POLICY']);
});

// R6-P7: orientation and ranking from the discovery samples, with no extra read.
test('R6-P7: the target is the side with unique keys; siblings that repeat their keys on both sides are demoted and suspect', async () => {
  const t2: typeof tables = {
    fa_sales: { cols: ['cust_sk', 'store_sk'], labels: [], rows: [['1', '1'], ['1', '2'], ['2', '1'], ['2', '2']] },
    fb_sales: { cols: ['cust_sk'], labels: [], rows: [['1'], ['1'], ['2'], ['2']] },
    dim_store: { cols: ['s_sk'], labels: [], rows: [['1'], ['2'], ['3']] }
  };
  const cfg2: any = { tables: Object.fromEntries(Object.entries(t2).map(([name, t]) => [name, { db: 'TPC', physicalTable: name, columns: t.cols.map(col), keyColumns: [], labels: [], role: 'table' }])) };
  const discovery2 = { tables: Object.fromEntries(Object.entries(t2).map(([name, t]) => [name, { columns: t.cols, sample: { rows: t.rows } }])) };
  const props = [prop('fa_sales', 'cust_sk', 'fb_sales', 'cust_sk', 0.99), prop('dim_store', 's_sk', 'fa_sales', 'store_sk', 0.5)];
  const client: any = { async runSql(sql: string, limit = 50) {
    const name = Object.keys(t2).find(n => new RegExp(`\\b${n}\\b`).test(sql))!, t = t2[name], where = /WHERE (\w+) IN \(([^)]*)\)/.exec(sql)!, values = [...where[2].matchAll(/'([^']*)'/g)].map(m => m[1]), at = t.cols.indexOf(where[1]);
    return { sql, rows: t.rows.filter(r => values.includes(r[at])).slice(0, limit).map(r => [r[at]]), requestId: 'r', queryId: 'q', durationMs: 0, utc: 'x' };
  } };
  const go = async (blind: boolean, maxProbes = 1) => { const budget = new RunBudget(limitsFromBounds({})); return runPostComa({ cfg: cfg2, catalog: { postComa: { maxProbes, ...(blind ? { blind } : {}) } } as any, discovery: discovery2, proposals: props, client: budgetedClient(client, budget) as any, budget, thresholds }); };
  const blind = await go(true, 2), p = byId(blind);
  const oriented = p['fa_sales.store_sk__dim_store.s_sk'];
  assert.ok(oriented, 'dim_store.s_sk -> fa_sales.store_sk is turned so the unique side is the target');
  assert.equal(oriented.structure.orientation, 'SWAPPED_TARGET_UNIQUE');
  assert.deepEqual([oriented.from.table, oriented.to.table], ['fa_sales', 'dim_store']);
  const sib = p['fa_sales.cust_sk__fb_sales.cust_sk'];
  assert.equal(sib.structure.rankClass, 'BOTH_SIDES_DUPLICATED');
  assert.equal(sib.coverageProbe.diagnostic.coverage.level, 'HIGH');
  assert.deepEqual([sib.coverageProbe.diagnostic.suspect.value, sib.coverageProbe.diagnostic.suspect.reasons], [true, ['TARGET_NOT_UNIQUE']]);
  assert.equal(blind.proposals[0].proposalId, 'fa_sales.store_sk__dim_store.s_sk', 'the pair that repeats values on both sides ranks last despite its score');
  const capped = await go(true, 1);
  assert.deepEqual(capped.notExecutedByBudget.map(x => x.proposalId), ['fa_sales.cust_sk__fb_sales.cust_sk']);
  const plain = await go(false, 2);
  assert.ok(plain.proposals.every((x: any) => !x.structure && !x.coverageProbe.diagnostic?.suspect.reasons.includes('TARGET_NOT_UNIQUE')), 'non-blind output is unchanged');
  assert.equal(plain.proposals[0].proposalId, 'fa_sales.cust_sk__fb_sales.cust_sk');
});

// C1/C2 of the TPCDS live: measurement follows the oriented pair; declared keys steer the ranking; key to key is suspect.
function mini(t2: Record<string, { cols: string[]; rows: string[][]; key?: string[] }>) {
  const cfg2: any = { tables: Object.fromEntries(Object.entries(t2).map(([name, t]) => [name, { db: 'TPC', physicalTable: name, columns: t.cols.map(col), keyColumns: t.key ?? [], labels: [], role: 'table' }])) };
  const discovery2 = { tables: Object.fromEntries(Object.entries(t2).map(([name, t]) => [name, { columns: t.cols, sample: { rows: t.rows } }])) };
  const reads: string[] = [];
  const client: any = { async runSql(sql: string, limit = 50) {
    reads.push(sql);
    const name = Object.keys(t2).find(n => new RegExp(`\\b${n}\\b`).test(sql))!, t = t2[name], where = /WHERE (\w+) IN \(([^)]*)\)/.exec(sql)!, values = [...where[2].matchAll(/'([^']*)'/g)].map(m => m[1]), at = t.cols.indexOf(where[1]);
    return { sql, rows: t.rows.filter(r => values.includes(r[at])).slice(0, limit).map(r => [r[at]]), requestId: 'r', queryId: 'q', durationMs: 0, utc: 'x' };
  } };
  const go = async (props: any[], maxProbes = 10) => { const budget = new RunBudget(limitsFromBounds({})); const report = await runPostComa({ cfg: cfg2, catalog: { postComa: { maxProbes, blind: true } } as any, discovery: discovery2, proposals: props, client: budgetedClient(client, budget) as any, budget, thresholds }); return { report, reads }; };
  return go;
}

test('C1: after the inversion the read, the coverage and the uniqueness follow the oriented pair; a unique parent is not TARGET_NOT_UNIQUE', async () => {
  const go = mini({ fact: { cols: ['page_sk', 'x'], rows: [['1', 'a'], ['1', 'b'], ['2', 'c'], ['2', 'd'], ['3', 'e']] }, page: { cols: ['p_page_sk'], key: ['p_page_sk'], rows: [['1'], ['2'], ['3'], ['4']] } });
  const { report, reads } = await go([prop('page', 'p_page_sk', 'fact', 'page_sk', 0.9)]);
  const item = report.proposals[0] as any, d = item.coverageProbe.diagnostic;
  assert.equal(item.structure.orientation, 'SWAPPED_TARGET_UNIQUE');
  assert.deepEqual([item.from.table, item.to.table], ['fact', 'page']);
  assert.match(reads[0], /^SELECT p_page_sk FROM .*page/);
  assert.deepEqual([d.multiplicity.from.duplicateKeys.length > 0, d.multiplicity.to.duplicateKeys.length, d.keyRules.targetUniqueness.status, d.suspect.value], [true, 0, 'NO_DUPLICATES_IN_SAMPLE', false]);
});

test('C2: a declared single-column key as target ranks first, key to key ranks last and is suspect KEY_TO_KEY', async () => {
  const go = mini({
    demo: { cols: ['cd_sk'], key: ['cd_sk'], rows: [['1'], ['2'], ['3']] }, hh: { cols: ['hd_sk'], key: ['hd_sk'], rows: [['1'], ['2'], ['3']] },
    fact: { cols: ['demo_sk', 'plain'], rows: [['1', '1'], ['1', '2'], ['2', '3'], ['3', '3']] }, other: { cols: ['plain'], rows: [['1'], ['2'], ['3']] } });
  const { report } = await go([prop('demo', 'cd_sk', 'hh', 'hd_sk', 0.99), prop('fact', 'plain', 'other', 'plain', 0.95), prop('fact', 'demo_sk', 'demo', 'cd_sk', 0.5)]);
  assert.deepEqual(report.proposals.map(p => p.proposalId), ['fact.demo_sk__demo.cd_sk', 'fact.plain__other.plain', 'demo.cd_sk__hh.hd_sk']);
  const k2k = report.proposals[2] as any;
  assert.equal(k2k.structure.rankClass, 'KEY_TO_KEY');
  assert.deepEqual(k2k.coverageProbe.diagnostic.suspect.reasons, ['KEY_TO_KEY']);
  assert.deepEqual((report.proposals[0] as any).coverageProbe.diagnostic.suspect.reasons, []);
});
