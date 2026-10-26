import test from 'node:test';
import assert from 'node:assert/strict';
import { nameAffinity, runPostComa } from '../src/agent/post-coma.ts';
import { RunBudget, budgetedClient, limitsFromBounds } from '../src/agent/run-budget.ts';

const col = (name: string) => ({ name, type: 'string' });
const keys = [['1'], ['2'], ['3'], ['1'], ['2'], ['3']];
const tables: Record<string, { cols: string[]; rows: string[][]; key: string[] }> = {
  store_sales: { cols: ['ss_store_sk', 'ss_other_sk'], rows: keys.map(k => [k[0], k[0]]), key: [] },
  store: { cols: ['s_store_sk'], rows: [['1'], ['2'], ['3']], key: ['s_store_sk'] },
  web_site: { cols: ['web_site_sk'], rows: [['1'], ['2'], ['3']], key: ['web_site_sk'] }
};
const cfg: any = { tables: Object.fromEntries(Object.entries(tables).map(([n, t]) => [n, { db: 'T', physicalTable: n, columns: t.cols.map(col), keyColumns: t.key, labels: [], role: 'table' }])) };
const discovery = { tables: Object.fromEntries(Object.entries(tables).map(([n, t]) => [n, { columns: t.cols, sample: { rows: t.rows } }])) };
const proposal = (column: string, table: string, toColumn: string, rawScore: number) => ({ providerId: 'p', providerVersion: '1', method: 'COMA', from: { db: 'T', table: 'store_sales', column }, to: { db: 'T', table, column: toColumn }, rawScore, reason: 'COMA_COLUMN_PAIR_OUT_OF_SCOPE', verificationStatus: 'NO VERIFICADO/UNKNOWN' as const, reviewState: 'PENDING' as const, inputHash: 'h', configHash: 'c', evidenceRefs: [] });
const client: any = { async runSql(sql: string) {
  const t = /\b(store|web_site)\b(?! *=)/.exec(sql.replace('store_sales', ''))![1], inList = [...sql.matchAll(/'(\d+)'/g)].map(m => m[1]);
  return { sql, rows: tables[t].rows.filter(r => inList.includes(r[0])), requestId: 'r', queryId: 'q', durationMs: 0, utc: 'x' };
} };
const thresholds = { sustainedOverlap: 0.8, sustainedLabelAgreement: 0.8, misleadingLabelAgreement: 0.5 };
const go = (proposals: any[], postComa: any) => { const budget = new RunBudget(limitsFromBounds({})); return runPostComa({ cfg, catalog: { postComa: { maxProbes: 5, ...postComa } } as any, discovery, proposals, client: budgetedClient(client, budget) as any, budget, thresholds }); };
const byId = (r: any, id: string) => r.proposals.find((p: any) => p.proposalId === id).coverageProbe.diagnostic;

test('P5: name affinity looks at the target table name only', () => {
  assert.equal(nameAffinity('ss_store_sk', { table: 'store', column: 's_store_sk' }), 1);
  assert.equal(nameAffinity('ss_store_sk', { table: 'web_site', column: 'web_site_sk' }), 0);
  assert.equal(nameAffinity('ss_addr_sk', { table: 'customer_address', column: 'ca_address_sk' }), 0, 'abbreviations decide nothing');
});

test('P5: with the guard, the homonym target of the same source column is flagged COMPETING_TARGET and the name-matching target stays accepted', async () => {
  const both = [proposal('ss_store_sk', 'store', 's_store_sk', 0.9), proposal('ss_store_sk', 'web_site', 'web_site_sk', 0.95)];
  const off = await go(both, { blind: true });
  assert.deepEqual([byId(off, 'store_sales.ss_store_sk__web_site.web_site_sk').suspect.value, byId(off, 'store_sales.ss_store_sk__store.s_store_sk').suspect.value], [false, false], 'without the guard both are accepted (the measured case)');
  const on = await go(both, { blind: true, homonymGuard: true });
  const web = byId(on, 'store_sales.ss_store_sk__web_site.web_site_sk');
  assert.deepEqual([web.coverage.level, web.suspect.value, web.suspect.reasons, web.suspect.preferredTarget], ['HIGH', true, ['COMPETING_TARGET'], 'store_sales.ss_store_sk__store.s_store_sk'], 'a higher COMA score does not win over the name');
  assert.equal(byId(on, 'store_sales.ss_store_sk__store.s_store_sk').suspect.value, false);
});

test('P5: equal name affinity decides nothing, and a lone target is untouched', async () => {
  const tie = await go([proposal('ss_other_sk', 'store', 's_store_sk', 0.9), proposal('ss_other_sk', 'web_site', 'web_site_sk', 0.8)], { blind: true, homonymGuard: true });
  assert.ok(tie.proposals.every(p => p.coverageProbe.diagnostic!.suspect.value === false));
  const alone = await go([proposal('ss_store_sk', 'web_site', 'web_site_sk', 0.9)], { blind: true, homonymGuard: true });
  assert.equal(alone.proposals[0]!.coverageProbe.diagnostic!.suspect.value, false);
});
