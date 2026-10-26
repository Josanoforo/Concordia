import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverUniverse, universeConfig } from '../src/universe-pipeline.ts';
import { isFullEvidenceSql } from '../src/clients/zetaris.ts';
import { zetarisTableSpecs } from '../src/relations/adapters/zetaris.ts';
import { DEFAULT_BLIND_PROBE_MODE, distinctKeySampleSql, ensureDispersedSeeds, estimateSeedQueries, pickDispersed, resolveProbeMode, sampleDistinctKeys, seedTargetsOf, seedValues, SEED_COUNT } from '../src/probe/sampling.ts';
import { formFixtureClient } from './helpers/form-fixture-client.ts';
import { clusteredTpcdsTables, M12_RELATIONS, probeWithSeeds } from './helpers/tpcds-clustered.ts';

const cfg = () => universeConfig('TPCDS');
const distinct = (values: unknown[]) => new Set(values.map(String)).size;
async function discovery(log: string[] = []) {
  const client = formFixtureClient(cfg(), clusteredTpcdsTables(), log);
  return { client, discovery: await discoverUniverse('TPCDS', { client: client as any, persist: false, executionMode: 'LOCAL' }) };
}

test('pickDispersed: deterministic, sorted numerically, spans the pool, never more than count, drops nulls', () => {
  const pool = Array.from({ length: 100 }, (_, i) => i * 3 + 2450000).reverse();
  const picks = pickDispersed([...pool, null as never], 10, 'TPCDS:inventory.inv_date_sk');
  assert.equal(picks.length, 10);
  assert.deepEqual(picks, pickDispersed(pool, 10, 'TPCDS:inventory.inv_date_sk'), 'same seed, same keys');
  assert.deepEqual([...picks].sort((a, b) => Number(a) - Number(b)), picks, 'returned in key order');
  assert.ok(Number(picks[0]) < 2450030 && Number(picks.at(-1)) > 2450270, 'spans the whole pool, not its first rows');
  assert.notDeepEqual(picks, pickDispersed(pool, 10, 'TPCDS:inventory.inv_warehouse_sk'), 'another column takes another phase');
  assert.deepEqual(pickDispersed(['9', '10', '2'], 5, 's'), ['2', '9', '10'], 'a small pool is returned whole, numbers compared as numbers');
  assert.deepEqual(pickDispersed([null, undefined] as never, 3, 's'), []);
  assert.throws(() => pickDispersed(pool, 0, 's'), /SAMPLING_COUNT_INVALID/);
});

test('distinctKeySampleSql is exactly form F4 and passes the real read guard; a column outside the config is refused', () => {
  const spec = zetarisTableSpecs(cfg()).inventory;
  const sql = distinctKeySampleSql(spec, 'inv_warehouse_sk');
  assert.equal(sql, 'SELECT DISTINCT inv_warehouse_sk FROM (SELECT inv_date_sk, inv_item_sk, inv_warehouse_sk FROM TPCDS_DB.inventory) concordia_source WHERE inv_warehouse_sk IS NOT NULL LIMIT 100');
  assert.ok(isFullEvidenceSql(sql));
  assert.throws(() => distinctKeySampleSql(spec, 'not_a_column'), /SAMPLING_COLUMN_OUTSIDE_CONFIG/);
  assert.throws(() => distinctKeySampleSql(spec, 'inv_warehouse_sk; DROP', 10), /INVALID_SQL_IDENTIFIER/);
  assert.throws(() => distinctKeySampleSql(spec, 'inv_warehouse_sk', 101), /SAMPLING_POOL_LIMIT_OUT_OF_RANGE/);
});

test('resolveProbeMode: blind universes default to distinct-keys, a declared or overriding mode wins, anything else is refused', () => {
  assert.equal(DEFAULT_BLIND_PROBE_MODE, 'distinct-keys');
  assert.equal(resolveProbeMode({ blind: true }), 'distinct-keys');
  assert.equal(resolveProbeMode({ blind: false }), undefined, 'configured-relation universes keep their behaviour');
  assert.equal(resolveProbeMode({ blind: false, declared: 'distinct-keys' }), 'distinct-keys');
  assert.equal(resolveProbeMode({ blind: true, declared: undefined, override: 'distinct-keys' }), 'distinct-keys');
  assert.throws(() => resolveProbeMode({ blind: true, declared: 'rows' }), /PROBE_MODE_INVALID/);
});

test('M12 reproduced on the fixture: the first-N-rows discovery sample holds ONE distinct key in each of the 3 columns', async () => {
  const { discovery: found } = await discovery();
  for (const relation of M12_RELATIONS) assert.equal(distinct(seedValues(found.tables[relation.from.table], relation.from.column)), 1, relation.id);
});

test('P2: dispersed seeds bring each M12 column to at least 3 distinct keys with one F4 read per distinct source endpoint', async () => {
  const log: string[] = [], { client, discovery: found } = await discovery(log);
  const before = log.length, targets = seedTargetsOf(M12_RELATIONS);
  assert.equal(targets.length, 3);
  assert.equal(estimateSeedQueries([...M12_RELATIONS, ...M12_RELATIONS]), 3, 'one read per distinct endpoint, never per relation');
  const result = await ensureDispersedSeeds(client as any, { cfg: cfg(), discovery: found, targets, scope: 'TPCDS:run-1' });
  assert.deepEqual(result.failures, []); assert.equal(result.queries, 3); assert.equal(log.length - before, 3);
  assert.ok(log.slice(before).every(sql => /^SELECT DISTINCT \w+ FROM \(SELECT .* concordia_source WHERE \w+ IS NOT NULL LIMIT 100$/.test(sql) && isFullEvidenceSql(sql)));
  for (const relation of M12_RELATIONS) {
    const seeds = seedValues(found.tables[relation.from.table], relation.from.column);
    assert.ok(distinct(seeds) >= 3, `${relation.id}: ${seeds.length} distinct keys`);
    const record = found.tables[relation.from.table].dispersedKeySeeds[relation.from.column];
    assert.equal(record.method, 'DISTINCT_POOL_STRIDE'); assert.equal(record.poolExhausted, true, 'the fixture column has fewer distinct values than the pool limit'); assert.ok(record.requestId && record.queryId);
  }
  const again = await ensureDispersedSeeds(client as any, { cfg: cfg(), discovery: found, targets, scope: 'TPCDS:run-1' });
  assert.equal(again.queries, 0, 'seeds already read for the run are not read twice');
});

test('P2: with the dispersed seeds the three M12 relations reach SOSTENIDA; with the first-N-rows seeds they stay INDETERMINADA insufficient_distinct_sample_keys', async () => {
  const { client, discovery: found } = await discovery();
  const firstRows = new Map(M12_RELATIONS.map(relation => [relation.id, [...new Set(seedValues(found.tables[relation.from.table], relation.from.column).map(String))]]));
  await ensureDispersedSeeds(client as any, { cfg: cfg(), discovery: found, targets: seedTargetsOf(M12_RELATIONS), scope: 'TPCDS:run-1' });
  for (const relation of M12_RELATIONS) {
    const before = await probeWithSeeds(client, relation, firstRows.get(relation.id)!);
    assert.deepEqual([before.decision.verdict, before.decision.reasonCodes[0]], ['INDETERMINADA', 'insufficient_distinct_sample_keys'], relation.id);
    const after = await probeWithSeeds(client, relation, seedValues(found.tables[relation.from.table], relation.from.column).slice(0, SEED_COUNT) as (string | number)[]);
    assert.equal(after.decision.verdict, 'SOSTENIDA', relation.id);
    assert.ok(after.decision.requirementsMissing.includes('global_coverage_not_established'), 'sampling alone never claims global coverage');
  }
});

test('P2: a failed F4 read leaves the first-N-rows sample for that column and is reported, not hidden', async () => {
  const { discovery: found } = await discovery();
  const failing = { async runSql() { throw Object.assign(new Error('boom'), { code: 'AGENT_QUERY_BUDGET_EXHAUSTED' }); } };
  const result = await ensureDispersedSeeds(failing as any, { cfg: cfg(), discovery: found, targets: [{ table: 'inventory', column: 'inv_warehouse_sk' }, { table: 'nope', column: 'x' }], scope: 'TPCDS:run-1' });
  assert.deepEqual(result.failures, [{ table: 'inventory', column: 'inv_warehouse_sk', code: 'AGENT_QUERY_BUDGET_EXHAUSTED' }, { table: 'nope', column: 'x', code: 'SAMPLING_TABLE_NOT_DISCOVERED' }]);
  assert.equal(distinct(seedValues(found.tables.inventory, 'inv_warehouse_sk')), 1, 'unchanged first-N-rows fallback');
});

test('sampleDistinctKeys reports a pool that hit the limit as not exhausted', async () => {
  const spec = zetarisTableSpecs(cfg()).inventory;
  const rows = Array.from({ length: 100 }, (_, i) => [i + 1]);
  const client = { async runSql(sql: string) { return { sql, rows, requestId: 'r', queryId: 'q', durationMs: 0, utc: 't' }; } };
  const seed = await sampleDistinctKeys(client as any, { table: 'inventory', column: 'inv_date_sk', spec, scope: 's', count: 5 });
  assert.equal(seed.poolSize, 100); assert.equal(seed.poolExhausted, false); assert.equal(seed.keys.length, 5);
});
