import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SQL, checkDistinctKeys } from '../scripts/check-distinct-keys.ts';

test('check-distinct-keys offline: one line per side plus a hypothetical verdict, 2 SQL, the source read is DISTINCT', async () => {
  const lines: any[] = [];
  const out = await checkDistinctKeys({ universe: 'TPCDS', from: 'store_sales.ss_store_sk', to: 'store.s_store_sk', offline: true }, line => lines.push(line));
  assert.equal(out.sent, MAX_SQL); assert.equal(lines.length, 3);
  assert.equal(lines[0].side, 'SOURCE'); assert.match(lines[0].sql, /^SELECT DISTINCT ss_store_sk /); assert.equal(lines[0].truncated, false);
  assert.equal(lines[0].standIn, 'DISTINCT_EMULATED_BY_OFFLINE_FIXTURE'); assert.equal(lines[1].standIn, undefined);
  assert.equal(lines[1].side, 'TARGET'); assert.ok(!lines[1].sql.includes('DISTINCT'));
  assert.equal(lines[2].hypotheticalContract, true); assert.equal(lines[2].notAHumanReview, true); assert.equal(lines[2].verdict, 'SOSTENIDA'); assert.equal(lines[2].mode, 'OFFLINE_FIXTURE');
});

test('check-distinct-keys refuses endpoints outside the allowlist and never exceeds the SQL cap', async () => {
  await assert.rejects(checkDistinctKeys({ universe: 'TPCDS', from: 'store_sales.nope', to: 'store.s_store_sk', offline: true }, () => {}), (e: any) => e.code === 'CHECK_ENDPOINT_OUTSIDE_ALLOWLIST');
  let calls = 0;
  const client = { runSql: async (sql: string) => { calls++; return { sql, rows: [['1'], ['2'], ['3']], requestId: 'r', queryId: 'q', durationMs: 0, utc: '2026-10-25T00:00:00.000Z' }; } };
  const inventory = { tables: { store_sales: { columns: ['ss_store_sk'], schema: [], sample: { rows: [['1'], ['2'], ['3']] }, labels: [], keyColumns: [], role: 'fact' }, store: { columns: ['s_store_sk'], schema: [], sample: { rows: [['1']] }, labels: [], keyColumns: ['s_store_sk'], role: 'dimension' } } };
  await checkDistinctKeys({ universe: 'TPCDS', from: 'store_sales.ss_store_sk', to: 'store.s_store_sk', client, inventory }, () => {});
  assert.ok(calls <= MAX_SQL);
});

test('--offline never reads the local config; live loads it before creating the client', async () => {
  let loads = 0;
  await checkDistinctKeys({ universe: 'TPCDS', from: 'store_sales.ss_store_sk', to: 'store.s_store_sk', offline: true, loadEnv: () => { loads++; } }, () => {});
  assert.equal(loads, 0);
  await assert.rejects(checkDistinctKeys({ universe: 'TPCDS', from: 'store_sales.nope', to: 'store.s_store_sk', loadEnv: () => { loads++; } }, () => {}));
  assert.equal(loads, 1, 'the config is loaded first in live mode (the bad endpoint then stops the call before any client or SQL)');
});
