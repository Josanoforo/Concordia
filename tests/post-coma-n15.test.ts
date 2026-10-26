import test from 'node:test';
import assert from 'node:assert/strict';
import { runPostComa } from '../src/agent/post-coma.ts';
import { RunBudget, budgetedClient, limitsFromBounds } from '../src/agent/run-budget.ts';

const col = (name: string) => ({ name, type: 'string' });
const promo = [['1', '1', 'Summer sale'], ['2', '2', 'Winter sale'], ['3', '3', 'Spring sale']];
const item = [['1', 'Blue shirt'], ['2', 'Red hat'], ['3', 'Green scarf']];
const cfg = (promoKey: string[]): any => ({ tables: {
  promo: { db: 'T', physicalTable: 'promo', columns: ['p_sk', 'p_item_sk', 'p_name'].map(col), keyColumns: promoKey, labels: ['p_name'], role: 'dimension' },
  item: { db: 'T', physicalTable: 'item', columns: ['i_sk', 'i_name'].map(col), keyColumns: ['i_sk'], labels: ['i_name'], role: 'dimension' } } });
const discovery = { tables: { promo: { columns: ['p_sk', 'p_item_sk', 'p_name'], sample: { rows: promo } }, item: { columns: ['i_sk', 'i_name'], sample: { rows: item } } } };
const proposal = (column: string, table = 'promo', toColumn = 'i_sk', toTable = 'item') => ({ providerId: 'p', providerVersion: '1', method: 'COMA', from: { db: 'T', table, column }, to: { db: 'T', table: toTable, column: toColumn }, rawScore: 0.9, reason: 'COMA_COLUMN_PAIR_OUT_OF_SCOPE', verificationStatus: 'NO VERIFICADO/UNKNOWN' as const, reviewState: 'PENDING' as const, inputHash: 'h', configHash: 'c', evidenceRefs: [] });
const client: any = { async runSql(sql: string) { return { sql, rows: item.map(r => [r[0], r[1]]), requestId: 'r', queryId: 'q', durationMs: 0, utc: 'x' }; } };
const thresholds = { sustainedOverlap: 0.8, sustainedLabelAgreement: 0.8, misleadingLabelAgreement: 0.5 };
const go = (config: any, blind: boolean, p = proposal('p_item_sk')) => { const budget = new RunBudget(limitsFromBounds({})); return runPostComa({ cfg: config, catalog: { postComa: { maxProbes: 2, ...(blind ? { blind: true } : {}) } } as any, discovery, proposals: [p], client: budgetedClient(client, budget) as any, budget, thresholds }); };

test('N15: in blind discovery the labels of a table are not compared through one of its foreign-key-like columns', async () => {
  const d = (await go(cfg(['p_sk']), true)).proposals[0]!.coverageProbe.diagnostic!;
  assert.equal(d.labels.signal, 'NOT_COMPARABLE'); assert.equal((d.labels as any).reason, 'SOURCE_LABELS_DESCRIBE_ANOTHER_ENTITY');
  assert.deepEqual([d.coverage.level, d.suspect.value], ['HIGH', false], 'a true promotion -> item reference is no longer a false LABEL_CONFLICT');
});

test('N15: homonymous keys of two labelled tables, and tables without declared keys, are still compared; non-blind output is unchanged', async () => {
  assert.equal((await go(cfg(['p_sk']), true, proposal('p_sk'))).proposals[0]!.coverageProbe.diagnostic!.labels.signal, 'LABEL_CONFLICT', 'source column is its own key: same-entity claim, compared');
  assert.equal((await go(cfg([]), true)).proposals[0]!.coverageProbe.diagnostic!.labels.signal, 'LABEL_CONFLICT', 'no declared key: nothing to decide from, compared as before');
  assert.equal((await go(cfg(['p_sk']), false)).proposals[0]!.coverageProbe.diagnostic!.labels.signal, 'LABEL_CONFLICT', 'configured universes keep the old comparison');
});
