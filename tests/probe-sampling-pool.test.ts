import test from 'node:test';
import assert from 'node:assert/strict';
import { isFullEvidenceSql } from '../src/clients/zetaris.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import type { FixtureTable } from '../src/eval/fixture-client.ts';
import { createSourcePoolReader, degenerateSampleColumns, estimateSeedQueries, pickDispersed, seedValues, SEED_COUNT, widenSourcePool } from '../src/probe/sampling.ts';
import { discoverUniverse, universeConfig } from '../src/universe-pipeline.ts';
import { formFixtureClient } from './helpers/form-fixture-client.ts';
import { clusteredTpcdsTables, M12_RELATIONS, probeWithSeeds } from './helpers/tpcds-clustered.ts';

/** E3-07a. The six source columns that stayed at ONE distinct key in the interrupted live pass 1: the tables are stored in date or warehouse order. */
const LIVE_COLUMNS = [
  { table: 'inventory', column: 'inv_warehouse_sk' }, { table: 'inventory', column: 'inv_date_sk' }, { table: 'catalog_page', column: 'cp_end_date_sk' },
  { table: 'catalog_page', column: 'cp_start_date_sk' }, { table: 'catalog_sales', column: 'cs_sold_date_sk' }, { table: 'store_sales', column: 'ss_sold_date_sk' }
];
const MIN_DISTINCT_KEYS = 3;
const cfg = () => universeConfig('TPCDS');
const distinct = (values: readonly unknown[]) => new Set(values.map(String)).size;

/** The table stored in key order: the first 30 rows carry one value of the column (more than the 20-row discovery sample), the rest carry five. Pads to 45 rows when the fixture is shorter. */
function clusterColumn(tables: Record<string, FixtureTable>, table: string, column: string) {
  const t = tables[table], index = t.columns.findIndex(item => item.name === column);
  assert.ok(index >= 0, `${table}.${column} is in the fixture`);
  while (t.rows.length < 45) t.rows.push([...t.rows[t.rows.length % Math.max(1, t.rows.length)]]);
  t.rows.forEach((row, position) => { row[index] = column.endsWith('warehouse_sk') ? (position < 30 ? 1 : 1 + (position % 5)) : position < 30 ? 2450001 : 2450002 + (position % 4); });
}
function liveShapedTables() {
  const tables = clusteredTpcdsTables();
  for (const { table, column } of LIVE_COLUMNS) clusterColumn(tables, table, column);
  return tables;
}
async function setup(log: string[] = []) {
  const client = formFixtureClient(cfg(), liveShapedTables(), log);
  const discovery = await discoverUniverse('TPCDS', { client: client as any, persist: false, executionMode: 'LOCAL' });
  return { client, discovery, sampled: (target: { table: string; column: string }) => seedValues(discovery.tables[target.table], target.column) };
}

test('E3-07a: the live case reproduced: a 20-row discovery sample with ONE distinct key over a column that holds more is widened by F4 to at least 3 keys, traced and counted', async () => {
  const log: string[] = [], { client, sampled } = await setup(log);
  for (const target of LIVE_COLUMNS) assert.equal(distinct(sampled(target)), 1, `${target.table}.${target.column}: the sample is degenerate`);
  const reader = createSourcePoolReader({ client: client as any, cfg: cfg(), scope: 'TPCDS:run-1' }), before = log.length;
  for (const target of LIVE_COLUMNS) {
    const { keys, trace } = await reader.widen(target, sampled(target), MIN_DISTINCT_KEYS);
    assert.ok(distinct(keys) >= MIN_DISTINCT_KEYS, `${target.table}.${target.column}: ${distinct(keys)} distinct keys`);
    assert.deepEqual([trace.source, trace.reason, trace.sampleDistinct, trace.minDistinctKeys], ['GLOBAL_DISTINCT_F4', 'SAMPLE_BELOW_MINIMUM', 1, MIN_DISTINCT_KEYS]);
    assert.ok(trace.f4 && trace.f4.requestId && trace.f4.queryId && trace.f4.cached === undefined && trace.f4.keysPicked === keys.length, 'traced with its query');
    assert.ok(isFullEvidenceSql(trace.f4.sql) && /^SELECT DISTINCT \w+ FROM .* WHERE \w+ IS NOT NULL LIMIT 100$/.test(trace.f4.sql), 'the closed form F4');
  }
  assert.equal(log.length - before, 6, '+1 SQL per degenerate column');
  assert.deepEqual(reader.stats, { queries: 6, hits: 0, failures: 0 });
  assert.equal(degenerateSampleColumns((await setup()).discovery, LIVE_COLUMNS, MIN_DISTINCT_KEYS).length, 6);
  assert.equal(estimateSeedQueries(LIVE_COLUMNS.map(from => ({ from }))), 6);
});

test('E3-07a: a column read once is not read again in the run (many proposals share a source column), and the cached use is marked', async () => {
  const log: string[] = [], { client, sampled } = await setup(log), reader = createSourcePoolReader({ client: client as any, cfg: cfg(), scope: 'TPCDS:run-1' });
  const target = LIVE_COLUMNS[0], before = log.length;
  const [first, second] = await Promise.all([reader.widen(target, sampled(target), MIN_DISTINCT_KEYS), reader.widen(target, sampled(target), MIN_DISTINCT_KEYS)]);
  const third = await reader.widen(target, sampled(target), MIN_DISTINCT_KEYS);
  assert.equal(log.length - before, 1);
  assert.deepEqual(first.keys, second.keys); assert.deepEqual(first.keys, third.keys);
  assert.deepEqual([first.trace.f4?.cached, second.trace.f4?.cached, third.trace.f4?.cached], [undefined, true, true]);
  assert.deepEqual(reader.stats, { queries: 1, hits: 2, failures: 0 });
});

test('E3-07a: a sample that already has the minimum is NOT replaced and costs nothing', async () => {
  const log: string[] = [], { client, discovery } = await setup(log), reader = createSourcePoolReader({ client: client as any, cfg: cfg(), scope: 'TPCDS:run-1' });
  const target = { table: 'warehouse', column: 'w_warehouse_sk' }, sample = seedValues(discovery.tables.warehouse, 'w_warehouse_sk'), before = log.length;
  assert.ok(distinct(sample) >= MIN_DISTINCT_KEYS);
  const { keys, trace } = await reader.widen(target, sample, MIN_DISTINCT_KEYS);
  assert.deepEqual(keys, sample);
  assert.deepEqual([trace.source, trace.reason, trace.f4], ['DISCOVERY_SAMPLE', 'SAMPLE_SUFFICIENT', undefined]);
  assert.equal(log.length, before); assert.deepEqual(reader.stats, { queries: 0, hits: 0, failures: 0 });
  assert.equal(degenerateSampleColumns(discovery, [target], MIN_DISTINCT_KEYS).length, 0);
  assert.deepEqual((await reader.widen(target, ['a', 'b', 'c'], 3)).keys, ['a', 'b', 'c'], 'exactly the minimum is enough');
});

test('E3-07a: a failed F4 leaves the sample, is traced with its code, is not retried in the run; with no reader the sample is used and the trace says so', async () => {
  const { discovery } = await setup();
  let calls = 0;
  const failing = { async runSql() { calls++; throw Object.assign(new Error('x'), { code: 'AGENT_QUERY_BUDGET_EXHAUSTED' }); } };
  const reader = createSourcePoolReader({ client: failing as any, cfg: cfg(), scope: 's' }), target = LIVE_COLUMNS[0], sample = seedValues(discovery.tables[target.table], target.column);
  for (let attempt = 0; attempt < 2; attempt++) {
    const { keys, trace } = await reader.widen(target, sample, MIN_DISTINCT_KEYS);
    assert.deepEqual(keys, sample);
    assert.deepEqual([trace.source, trace.reason, trace.failureCode], ['DISCOVERY_SAMPLE', 'F4_FAILED', 'AGENT_QUERY_BUDGET_EXHAUSTED']);
  }
  assert.equal(calls, 1); assert.deepEqual(reader.stats, { queries: 1, hits: 1, failures: 1 });
  assert.equal((await reader.widen({ table: 'nope', column: 'x' }, ['1'], MIN_DISTINCT_KEYS)).trace.failureCode, 'SAMPLING_TABLE_NOT_DISCOVERED');
  const off = await widenSourcePool(undefined, target, sample, MIN_DISTINCT_KEYS);
  assert.deepEqual([off.keys, off.trace.source, off.trace.reason], [sample, 'DISCOVERY_SAMPLE', 'READER_ABSENT']);
});

test('E3-07a: when F4 itself knows no more than the sample, the sample is kept (F4_NOT_LARGER); a column that truly has one value is reported as that whole domain', async () => {
  const sample = [1, 2], stub = (rows: unknown[][]) => ({ async runSql(sql: string) { return { sql, rows, requestId: 'r', queryId: 'q', durationMs: 0, utc: 't' }; } });
  const narrower = await createSourcePoolReader({ client: stub([[7]]) as any, cfg: cfg(), scope: 's' }).widen(LIVE_COLUMNS[0], sample, MIN_DISTINCT_KEYS);
  assert.deepEqual([narrower.keys, narrower.trace.source, narrower.trace.reason], [sample, 'DISCOVERY_SAMPLE', 'F4_NOT_LARGER']);
  const single = await createSourcePoolReader({ client: stub([[7]]) as any, cfg: cfg(), scope: 's' }).widen(LIVE_COLUMNS[0], [7], MIN_DISTINCT_KEYS);
  assert.deepEqual([single.keys, single.trace.source, single.trace.f4?.poolExhausted], [[7], 'GLOBAL_DISTINCT_F4', true], 'the whole distinct set of the column is one value: the policy will say insufficient keys, with evidence');
});

test('E3-07a: with the widened seeds the M12 relations reach SOSTENIDA; with the degenerate sample they stay INDETERMINADA insufficient_distinct_sample_keys', async () => {
  const { client, sampled } = await setup(), reader = createSourcePoolReader({ client: client as any, cfg: cfg(), scope: 'TPCDS:run-1' });
  for (const relation of M12_RELATIONS) {
    const target = { table: relation.from.table, column: relation.from.column }, sample = sampled(target);
    const before = await probeWithSeeds(client, relation, [...new Set(sample)] as (string | number)[]);
    assert.deepEqual([before.decision.verdict, before.decision.reasonCodes[0]], ['INDETERMINADA', 'insufficient_distinct_sample_keys'], relation.id);
    const { keys } = await reader.widen(target, sample, MIN_DISTINCT_KEYS);
    const after = await probeWithSeeds(client, relation, keys.slice(0, SEED_COUNT) as (string | number)[]);
    assert.equal(after.decision.verdict, 'SOSTENIDA', relation.id);
  }
});

test('E3-07a: the pool is dispersed with the same seeded stride as P2 (same seed, same keys)', async () => {
  const { client, sampled } = await setup(), target = LIVE_COLUMNS[1], scope = 'TPCDS:run-9';
  const { keys, trace } = await createSourcePoolReader({ client: client as any, cfg: cfg(), scope }).widen(target, sampled(target), MIN_DISTINCT_KEYS);
  assert.equal(trace.f4?.seed, `${scope}:${target.table}.${target.column}`);
  assert.deepEqual(keys, pickDispersed(keys, SEED_COUNT, trace.f4!.seed), 'idempotent on its own pick');
});
