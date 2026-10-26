import test from 'node:test';
import assert from 'node:assert/strict';
import { isFullEvidenceSql } from '../src/clients/zetaris.ts';
import { limitsFromBounds, RunBudget } from '../src/agent/run-budget.ts';
import { measureTieEvidence } from '../src/agent/tie-evidence.ts';
import { zetarisTableSpecs } from '../src/relations/adapters/zetaris.ts';
import { cachedProfile, createProfileCache, extendedProfileDeclared, extendedProfileSql, measureColumnProfile, parseProfile, profileSql as profileSqlOf, type ColumnProfile } from '../src/probe/column-profile.ts';
import { attachFullEvidence, FULL_EVIDENCE_MAX_QUERIES, measureFullEvidence, missingCountSql, missingRowsSql, type FullEvidenceEndpoint } from '../src/probe/full-evidence.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { formFixtureClient } from './helpers/form-fixture-client.ts';
import { clusteredTpcdsTables, M12_RELATIONS, probeWithSeeds } from './helpers/tpcds-clustered.ts';

const cfg = universeConfig('TPCDS'), specs = zetarisTableSpecs(cfg), CHECKED_AT = '2026-10-25T00:00:00.000Z';
type Relation = (typeof M12_RELATIONS)[number];
const [WAREHOUSE, INV_DATE, CP_END_DATE] = M12_RELATIONS;
const CP_START_DATE: Relation = { ...CP_END_DATE, id: 'catalog_page.cp_start_date_sk__date_dim.d_date_sk', from: { ...CP_END_DATE.from, column: 'cp_start_date_sk' } };
function endpointsOf(relation: Relation): { from: FullEvidenceEndpoint; to: FullEvidenceEndpoint } {
  const one = (side: 'from' | 'to'): FullEvidenceEndpoint => {
    const endpoint = relation[side], column = (cfg.tables[endpoint.table].columns as { name: string; type: string }[]).find(item => item.name === endpoint.column);
    return { table: endpoint.table, column: endpoint.column, type: column?.type, spec: specs[endpoint.table], sourceId: `${endpoint.db}:${endpoint.table}:${side}` };
  };
  return { from: one('from'), to: one('to') };
}
const measure = (client: unknown, relation: Relation, extra: Partial<Parameters<typeof measureFullEvidence>[0]> = {}) => measureFullEvidence({ client: client as any, relationId: relation.id, ...endpointsOf(relation), checkedAt: CHECKED_AT, ...extra });
const profileOf = (client: unknown, table: string, column: string, extra: Partial<Parameters<typeof measureColumnProfile>[0]> = {}) => measureColumnProfile({ client: client as any, endpoint: { table, column, spec: specs[table] }, ...extra });
const measuredOnly = (profile: ColumnProfile) => { assert.equal(profile.provenance, 'GLOBAL_WHOLE_TABLE'); return profile as Extract<ColumnProfile, { provenance: 'GLOBAL_WHOLE_TABLE' }>; };
const isProfileSql = (sql: string) => /^SELECT COUNT\(\*\) AS concordia_rows, COUNT\(DISTINCT /.test(sql);
const dateSeeds = [2450001, 2450002, 2450003, 2450004, 2450005];

// ---------------------------------------------------------------- E1-06: per-run F1 cache

test('E1-06: N relations that point at the same target use ONE profile query of that target, with the same evidence and the same verdicts', async () => {
  const relations = [INV_DATE, CP_END_DATE, CP_START_DATE];
  const run = async (cache?: ReturnType<typeof createProfileCache>) => {
    const tables = clusteredTpcdsTables(); tables.catalog_page.rows.forEach((row, index) => { row[3] = 2450001 + (index % 5); }); // cp_start_date_sk spread over five dates, like the other two
    const log: string[] = [], client = formFixtureClient(cfg, tables, log), out = [];
    for (const relation of relations) {
      const evidence = await measure(client, relation, { cache });
      const probed = await probeWithSeeds(client, relation, dateSeeds, bundle => attachFullEvidence(bundle, evidence, endpointsOf(relation)));
      out.push({ evidence, decision: probed.decision });
    }
    return { out, targetScans: log.filter(sql => isProfileSql(sql) && sql.includes('TPCDS_DB.date_dim')).length, scans: log.filter(isProfileSql).length };
  };
  const cache = createProfileCache(), shared = await run(cache), baseline = await run();
  assert.equal(baseline.targetScans, 3, 'without a cache every relation scans date_dim again');
  assert.equal(shared.targetScans, 1, 'with the cache date_dim.d_date_sk is profiled once for the run');
  assert.equal(shared.scans, baseline.scans - 2);
  assert.deepEqual([cache.stats.queries, cache.stats.hits], [4, 2], '3 source scans + 1 target scan sent; the other two target uses were hits');
  for (const [index, relation] of relations.entries()) {
    const [cached, plain] = [shared.out[index], baseline.out[index]];
    assert.equal(cached.decision.verdict, 'SOSTENIDA', relation.id);
    assert.deepEqual(cached.decision, plain.decision, `${relation.id}: identical decision with and without the cache`);
    const strip = ({ queries, ...rest }: typeof cached.evidence) => rest;
    assert.deepEqual(strip(cached.evidence), strip(plain.evidence), `${relation.id}: identical measurements`);
    const target = cached.evidence.queries.find(query => query.form === 'F1_TARGET')!;
    assert.equal(target.cached, index === 0 ? undefined : true, 'only the first relation sent the target scan');
    assert.ok(target.requestId && target.queryId, 'the cached answer keeps the provenance of the scan that produced it');
    assert.equal(target.requestId, shared.out[0].evidence.queries.find(query => query.form === 'F1_TARGET')!.requestId);
  }
});

test('E1-06: a failed scan is not remembered (the next relation tries again), an F1x answers a later F1 but never the reverse, simultaneous asks share one query', async () => {
  const tables = clusteredTpcdsTables(), inner = formFixtureClient(cfg, tables);
  let calls = 0, fail = true;
  const client = { async runSql(sql: string, limit?: number) { calls++; if (fail) { fail = false; throw Object.assign(new Error('x'), { code: 'TIMEOUT' }); } return inner.runSql(sql, limit); } };
  const cache = createProfileCache();
  const first = await profileOf(client, 'warehouse', 'w_warehouse_sk', { cache });
  assert.deepEqual([first.profile.provenance, first.query.ok, first.query.errorCode], ['NOT_MEASURED', false, 'TIMEOUT']);
  assert.equal(cache.entries.size, 0, 'a failure is not cached');
  const second = await profileOf(client, 'warehouse', 'w_warehouse_sk', { cache });
  assert.equal(measuredOnly(second.profile).rows, 5); assert.equal(calls, 2);

  const log: string[] = [], plain = formFixtureClient(cfg, tables, log), fresh = createProfileCache();
  const basic = await profileOf(plain, 'warehouse', 'w_warehouse_sk', { cache: fresh });
  const extended = await profileOf(plain, 'warehouse', 'w_warehouse_sk', { cache: fresh, extended: true });
  assert.deepEqual([basic.query.cached, extended.query.cached, measuredOnly(extended.profile).form], [undefined, undefined, 'F1x'], 'F1 does not answer an F1x request: a second scan is sent');
  const again = await profileOf(plain, 'warehouse', 'w_warehouse_sk', { cache: fresh });
  assert.deepEqual([again.query.cached, measuredOnly(again.profile).form], [true, 'F1x'], 'the F1x already measured also answers an F1 request');
  assert.equal(cachedProfile(fresh, { table: 'warehouse', column: 'w_warehouse_sk' }, true)?.form, 'F1x'); assert.equal(cachedProfile(createProfileCache(), { table: 'warehouse', column: 'w_warehouse_sk' }, false), undefined);

  let concurrent = 0;
  const slow = { async runSql(sql: string, limit?: number) { concurrent++; await new Promise(resolve => setTimeout(resolve, 5)); return plain.runSql(sql, limit); } };
  const shared = createProfileCache(), [x, y] = await Promise.all([profileOf(slow, 'item', 'i_item_sk', { cache: shared }), profileOf(slow, 'item', 'i_item_sk', { cache: shared })]);
  assert.equal(concurrent, 1); assert.deepEqual([x.query.cached, y.query.cached], [undefined, true]); assert.deepEqual(x.profile, y.profile);
});

test('E1-06: measureTieEvidence shares the run cache with measureFullEvidence: a target already profiled costs no query and no budget', async () => {
  const log: string[] = [], client = formFixtureClient(cfg, clusteredTpcdsTables(), log), cache = createProfileCache();
  await measure(client, WAREHOUSE, { cache }); // profiles inventory.inv_warehouse_sk and warehouse.w_warehouse_sk
  const proposal = (id: string, to: [string, string]) => ({ proposalId: id, from: { table: 'inventory', column: 'inv_warehouse_sk' }, to: { table: to[0], column: to[1] }, coverageProbe: { status: 'EXECUTED', diagnostic: { coverage: { level: 'HIGH' }, suspect: { value: false } } } });
  const proposals = [proposal('p1', ['warehouse', 'w_warehouse_sk']), proposal('p2', ['date_dim', 'd_date_sk'])];
  const before = log.length, budget = new RunBudget(limitsFromBounds({ maxQueriesPerRun: 5 }));
  const tie = await measureTieEvidence({ cfg, client, budget, proposals, cache });
  assert.deepEqual([tie.queries, tie.cached, log.length - before], [1, ['warehouse.w_warehouse_sk'], 1], 'only date_dim.d_date_sk was scanned');
  assert.deepEqual(Object.keys(tie.measured).sort(), ['date_dim.d_date_sk', 'warehouse.w_warehouse_sk']);
  assert.equal(tie.measured['warehouse.w_warehouse_sk'].unique, true);
  // A starved budget still serves what the run already knows, and only reports what it truly cannot pay.
  const empty = new RunBudget(limitsFromBounds({ maxQueriesPerRun: 1 })); empty.chargeQuery();
  const lean = await measureTieEvidence({ cfg, client, budget: empty, proposals: [proposal('p1', ['warehouse', 'w_warehouse_sk']), proposal('p2', ['store', 's_store_sk'])], cache });
  assert.deepEqual([lean.cached, Object.keys(lean.measured), lean.notMeasured], [['warehouse.w_warehouse_sk'], ['warehouse.w_warehouse_sk'], [{ target: 'store.s_store_sk', reason: 'QUERY_BUDGET_INSUFFICIENT' }]]);
  // Without a cache the behaviour is the one of Round 9: one scan per target.
  const plain = await measureTieEvidence({ cfg, client, budget: new RunBudget(limitsFromBounds({ maxQueriesPerRun: 5 })), proposals });
  assert.deepEqual([plain.queries, plain.cached], [2, []]);
});

// ---------------------------------------------------------------- E1-07: NULLs in the anti-join

/** Inventory: 40 rows. Rows 30-32 reference warehouse 8, row 33 warehouse 9 (neither exists), rows 34-35 carry NO warehouse (NULL). Warehouse gets a row with a NULL key. */
function nullsFixture(options: { targetNull: boolean; orphans: boolean; sourceNulls: boolean }) {
  const tables = clusteredTpcdsTables();
  if (options.orphans) { for (const row of [30, 31, 32]) tables.inventory.rows[row][2] = 8; tables.inventory.rows[33][2] = 9; }
  if (options.sourceNulls) for (const row of [34, 35]) tables.inventory.rows[row][2] = null;
  if (options.targetNull) tables.warehouse.rows.push([null, 'WA_NULL', 'depot without key']);
  return tables;
}

test('E1-07: a NULL in the target column does not hide the orphans (a NOT IN would answer 0); the orphans are counted both by distinct keys and by rows', async () => {
  const log: string[] = [], client = formFixtureClient(cfg, nullsFixture({ targetNull: true, orphans: true, sourceNulls: false }), log);
  const evidence = await measure(client, WAREHOUSE);
  assert.equal(evidence.coverage.status, 'MEASURED');
  const coverage = evidence.coverage.status === 'MEASURED' ? evidence.coverage : undefined!;
  assert.deepEqual([coverage.sourceDistinct, coverage.missing, coverage.complete], [7, 2, false], 'warehouses 8 and 9 are orphans although the target holds a NULL key');
  assert.deepEqual(coverage.rows, { sourceNonNullRows: 40, sourceNulls: 0, missingRows: 4, ratio: 36 / 40, measuredBy: 'F3C' });
  assert.deepEqual(evidence.uniqueness.status === 'MEASURED' && [evidence.uniqueness.rows, evidence.uniqueness.distinct, evidence.uniqueness.nulls, evidence.uniqueness.unique], [6, 5, 1, true]);
  // What the pinned SQL rules out: NOT IN over a set that contains a NULL is never TRUE, so it would have counted zero orphans.
  const targetKeys: (number | null)[] = [1, 2, 3, 4, 5, null], notIn = (key: number) => targetKeys.every(other => other !== null && other !== key) ? true : targetKeys.includes(key) ? false : null;
  assert.equal([8, 9].filter(key => notIn(key) === true).length, 0, 'the NOT IN semantics this suite exists to avoid');
  for (const sql of log.filter(entry => /concordia_missing/.test(entry))) { assert.ok(!/\bNOT\s+IN\b/i.test(sql), sql); assert.match(sql, /LEFT JOIN/); assert.match(sql, /IS NOT NULL/); assert.ok(isFullEvidenceSql(sql), sql); }
  const { from, to } = endpointsOf(WAREHOUSE);
  assert.equal(isFullEvidenceSql(`SELECT COUNT(*) AS concordia_missing_rows FROM (SELECT inv_date_sk, inv_item_sk, inv_warehouse_sk FROM TPCDS_DB.inventory) concordia_s WHERE concordia_s.inv_warehouse_sk NOT IN (SELECT w_warehouse_sk FROM TPCDS_DB.warehouse)`), false, 'the guard refuses the NOT IN shape');
  assert.ok(isFullEvidenceSql(missingCountSql(from, to)) && isFullEvidenceSql(missingRowsSql(from, to)));
});

test('E1-07: NULL source keys are not orphans; their count is reported separately and stays out of the row denominator', async () => {
  // Source NULLs only: every non-null key exists in the target, so there is nothing missing, and the two NULL rows are reported on their own.
  const client = formFixtureClient(cfg, nullsFixture({ targetNull: false, orphans: false, sourceNulls: true }));
  const clean = await measure(client, WAREHOUSE);
  const coverage = clean.coverage.status === 'MEASURED' ? clean.coverage : undefined!;
  assert.deepEqual([coverage.sourceDistinct, coverage.missing, coverage.complete], [5, 0, true]);
  assert.deepEqual(coverage.rows, { sourceNonNullRows: 38, sourceNulls: 2, missingRows: 0, ratio: 1, measuredBy: 'DERIVED_FROM_F3B_ZERO' });
  assert.deepEqual(clean.queries.map(query => query.form), ['F1_TARGET', 'F1_SOURCE', 'F3B'], 'no orphan key, so no F3c is sent');
  assert.equal(clean.source?.nulls, 2);

  // Orphans AND NULLs on both sides: only the non-null keys that are absent count, the denominators drop the NULL rows.
  const both = await measure(formFixtureClient(cfg, nullsFixture({ targetNull: true, orphans: true, sourceNulls: true })), WAREHOUSE);
  const mixed = both.coverage.status === 'MEASURED' ? both.coverage : undefined!;
  assert.deepEqual([mixed.sourceDistinct, mixed.missing], [7, 2]);
  assert.deepEqual(mixed.rows, { sourceNonNullRows: 38, sourceNulls: 2, missingRows: 4, ratio: 34 / 38, measuredBy: 'F3C' });
  assert.equal(mixed.ratio, 5 / 7, 'the distinct ratio and the row ratio are two different denominators, both reported');
  assert.notEqual(mixed.rows!.ratio, mixed.ratio);
});

// ---------------------------------------------------------------- E3-03: F3c

test('E3-03: F3c is the closed form with the alias on its own source, accepted by the real guard; the worst case is FULL_EVIDENCE_MAX_QUERIES', async () => {
  const { from, to } = endpointsOf(WAREHOUSE);
  assert.equal(missingRowsSql(from, to), 'SELECT COUNT(*) AS concordia_missing_rows FROM (SELECT inv_date_sk, inv_item_sk, inv_warehouse_sk FROM TPCDS_DB.inventory) concordia_s LEFT JOIN (SELECT DISTINCT w_warehouse_sk AS k FROM (SELECT w_warehouse_sk, w_warehouse_id, w_warehouse_name FROM TPCDS_DB.warehouse) concordia_source) concordia_t ON concordia_s.inv_warehouse_sk = concordia_t.k WHERE concordia_s.inv_warehouse_sk IS NOT NULL AND concordia_t.k IS NULL');
  assert.ok(isFullEvidenceSql(missingRowsSql(from, to)));
  assert.throws(() => missingRowsSql({ ...from, column: 'x; DROP' }, to), /INVALID_SQL_IDENTIFIER/);
  const tables = nullsFixture({ targetNull: false, orphans: true, sourceNulls: false });
  tables.warehouse.rows.push([3, 'WA0003', 'again']);
  const worst = await measure(formFixtureClient(cfg, tables), WAREHOUSE, { sampleMissingKeys: true });
  assert.deepEqual(worst.queries.map(query => query.form), ['F1_TARGET', 'F2', 'F1_SOURCE', 'F3B', 'F3A', 'F3C']);
  assert.equal(worst.queries.length, FULL_EVIDENCE_MAX_QUERIES);
  const opted = await measure(formFixtureClient(cfg, nullsFixture({ targetNull: false, orphans: true, sourceNulls: false })), WAREHOUSE, { orphanRows: false });
  assert.deepEqual(opted.queries.map(query => query.form), ['F1_TARGET', 'F1_SOURCE', 'F3B'], 'orphanRows: false saves the query');
  assert.equal(opted.coverage.status === 'MEASURED' && opted.coverage.rows, undefined);
});

test('E3-03: both orphan semantics are measured and reported with their denominators, and the policy does not read the row one (decision unchanged)', async () => {
  const tables = nullsFixture({ targetNull: false, orphans: true, sourceNulls: false });
  const client = formFixtureClient(cfg, tables);
  const decisionFor = async (extra: Partial<Parameters<typeof measureFullEvidence>[0]>) => {
    const evidence = await measure(client, WAREHOUSE, extra);
    return { evidence, decision: (await probeWithSeeds(client, WAREHOUSE, [1, 2, 3], bundle => attachFullEvidence(bundle, evidence, endpointsOf(WAREHOUSE)))).decision };
  };
  const withRows = await decisionFor({}), withoutRows = await decisionFor({ orphanRows: false });
  const coverage = withRows.evidence.coverage.status === 'MEASURED' ? withRows.evidence.coverage : undefined!;
  assert.deepEqual([coverage.missing, coverage.sourceDistinct, coverage.ratio], [2, 7, 5 / 7], 'distinct keys: missing over distinct non-null source keys');
  assert.deepEqual([coverage.rows!.missingRows, coverage.rows!.sourceNonNullRows, coverage.rows!.ratio], [4, 40, 36 / 40], 'rows: missing over non-null source rows');
  assert.deepEqual(withRows.decision, withoutRows.decision, 'the policy reads the distinct-key ratio only, in this round');
  assert.equal(withRows.decision.verdict, 'ENGAÑOSA');
});

test('E3-03: a failed or inconsistent F3c leaves the F3b measurement intact and says why the rows are unmeasured', async () => {
  const tables = nullsFixture({ targetNull: false, orphans: true, sourceNulls: false }), inner = formFixtureClient(cfg, tables);
  const fails = { async runSql(sql: string, limit?: number) { if (/concordia_missing_rows/.test(sql)) throw Object.assign(new Error('x'), { code: 'TIMEOUT' }); return inner.runSql(sql, limit); } };
  const failed = await measure(fails, WAREHOUSE);
  assert.equal(failed.coverage.status === 'MEASURED' && failed.coverage.missing, 2);
  assert.deepEqual(failed.coverage.status === 'MEASURED' && failed.coverage.rowsNotMeasured, { reason: 'TIMEOUT' });
  assert.equal(failed.coverage.status === 'MEASURED' && failed.coverage.rows, undefined);
  for (const [answer, label] of [[1, 'fewer orphan rows than orphan keys'], [41, 'more orphan rows than source rows'], ['many', 'not a count']] as const) {
    const lying = { async runSql(sql: string, limit?: number) { return /concordia_missing_rows/.test(sql) ? { ...(await inner.runSql(sql, limit)), rows: [[answer]] } : inner.runSql(sql, limit); } };
    const result = await measure(lying, WAREHOUSE);
    assert.equal(result.coverage.status === 'MEASURED' && result.coverage.missing, 2, label);
    assert.deepEqual(result.coverage.status === 'MEASURED' && result.coverage.rowsNotMeasured, { reason: 'MALFORMED_RESPONSE' }, label);
  }
});

// ---------------------------------------------------------------- E3-05: F1x

test('E3-05: F1x is the closed form, accepted by the real guard, and the manifest flag is strict', () => {
  const { to } = endpointsOf(WAREHOUSE);
  assert.equal(extendedProfileSql(to), 'SELECT COUNT(*) AS concordia_rows, COUNT(DISTINCT w_warehouse_sk) AS concordia_distinct, SUM(CASE WHEN w_warehouse_sk IS NULL THEN 1 ELSE 0 END) AS concordia_nulls, MIN(w_warehouse_sk) AS concordia_min, MAX(w_warehouse_sk) AS concordia_max, AVG(LENGTH(CAST(w_warehouse_sk AS STRING))) AS concordia_avg_len FROM (SELECT w_warehouse_sk, w_warehouse_id, w_warehouse_name FROM TPCDS_DB.warehouse) concordia_source');
  assert.ok(isFullEvidenceSql(extendedProfileSql(to))); assert.ok(isFullEvidenceSql(profileSqlOf(to)));
  assert.equal(extendedProfileDeclared({ fullEvidenceExtendedProfile: true }), true);
  for (const value of [undefined, false, 'true', 1, null]) assert.equal(extendedProfileDeclared({ fullEvidenceExtendedProfile: value }), false);
  assert.equal(extendedProfileDeclared({ fullEvidence: { extendedProfile: true } } as never), false, 'the old nested spelling no longer counts');
  assert.equal(extendedProfileDeclared({ fullEvidence: true } as never), false, 'fullEvidence: true is F1 whole-table evidence only');
  assert.equal(extendedProfileDeclared(undefined), false); assert.equal(extendedProfileDeclared({}), false);
  assert.equal(extendedProfileDeclared(cfg), false, 'no shipped universe turns it on by itself');
});

test('E3-05: the extended profile adds MIN, MAX and the average key length in the same single scan, equal to the fixture values', async () => {
  const tables = clusteredTpcdsTables(), log: string[] = [], client = formFixtureClient(cfg, tables, log);
  const dates = tables.date_dim.rows.map(row => row[0] as number), lengths = dates.map(value => String(value).length);
  const { profile, query } = await profileOf(client, 'date_dim', 'd_date_sk', { extended: true });
  const measured = measuredOnly(profile);
  assert.deepEqual([measured.form, measured.rows, measured.distinct, measured.nulls, measured.min, measured.max], ['F1x', dates.length, new Set(dates).size, 0, Math.min(...dates), Math.max(...dates)]);
  assert.equal(measured.avgLen, lengths.reduce((a, b) => a + b, 0) / lengths.length);
  assert.deepEqual([log.length, query.ok, /concordia_avg_len/.test(query.sql)], [1, true, true], 'one scan');
  const text = measuredOnly((await profileOf(client, 'warehouse', 'w_warehouse_id', { extended: true })).profile);
  assert.deepEqual([text.min, text.max], ['WA0001', 'WA0005']); assert.equal(text.avgLen, 6);
  const plain = measuredOnly((await profileOf(client, 'date_dim', 'd_date_sk')).profile);
  assert.deepEqual([plain.form, plain.min, plain.max, plain.avgLen], ['F1', undefined, undefined, undefined], 'F1 carries counts only');
});

test('E3-05: an all-NULL column has counts and no min, max or length; a malformed F1x answer is NOT_MEASURED, never a guess', async () => {
  const tables = clusteredTpcdsTables();
  for (const row of tables.warehouse.rows) row[2] = null;
  const empty = measuredOnly((await profileOf(formFixtureClient(cfg, tables), 'warehouse', 'w_warehouse_name', { extended: true })).profile);
  assert.deepEqual([empty.rows, empty.distinct, empty.nulls, empty.min, empty.max, empty.avgLen], [5, 0, 5, undefined, undefined, undefined]);
  assert.equal(parseProfile([[3, 3, 0, 1, 3, 1]], true)?.avgLen, 1);
  assert.equal(parseProfile([[3, 3, 0]], true), null, 'F1x answer without its extra columns');
  assert.equal(parseProfile([[3, 3, 0, null, 3, 1]], true), null, 'non-null keys but a NULL min');
  assert.equal(parseProfile([[3, 3, 0, 1, 3, 'long']], true), null, 'a non-numeric length');
  assert.equal(parseProfile([[3, 3, 0, 1, 3, -1]], true), null);
  assert.equal(parseProfile([[3, 4, 0, 1, 3, 1]], true), null, 'more distinct keys than rows');
  assert.deepEqual(parseProfile([[0, 0, null, null, null, null]], true), { rows: 0, distinct: 0, nulls: 0 }, 'an empty table');
  const short = { async runSql() { return { sql: '', rows: [[3, 3, 0]], requestId: 'r', queryId: 'q', durationMs: 0, utc: 't' }; } };
  const malformed = await profileOf(short, 'warehouse', 'w_warehouse_sk', { extended: true });
  assert.deepEqual([malformed.profile.provenance, malformed.profile.provenance === 'NOT_MEASURED' && malformed.profile.reason], ['NOT_MEASURED', 'MALFORMED_RESPONSE']);
  const outside = await profileOf(short, 'warehouse', 'no_such_column');
  assert.deepEqual(outside.profile, { table: 'warehouse', column: 'no_such_column', provenance: 'NOT_MEASURED', reason: 'COLUMN_OUTSIDE_CONFIG' });
  assert.equal(outside.query.sql, '', 'nothing was sent');
});

test('E3-05: with the extended profile measureFullEvidence reports min, max and length of both sides with the same verdicts and the same number of queries as F1', async () => {
  const client = formFixtureClient(cfg, clusteredTpcdsTables());
  const plain = await measure(client, INV_DATE), extended = await measure(client, INV_DATE, { extendedProfile: true });
  assert.equal(extended.queries.length, plain.queries.length);
  assert.ok(extended.queries.filter(query => query.form.startsWith('F1')).every(query => /concordia_avg_len/.test(query.sql)));
  assert.ok(plain.queries.every(query => !/concordia_avg_len/.test(query.sql)));
  for (const side of [extended.source!, extended.target!]) assert.ok(side.min !== undefined && side.max !== undefined && typeof side.avgLen === 'number');
  assert.deepEqual([plain.source, plain.target], [{ rows: 40, distinct: 5, nulls: 0 }, { rows: extended.target!.rows, distinct: extended.target!.distinct, nulls: 0 }]);
  assert.deepEqual([extended.coverage, extended.uniqueness], [plain.coverage, plain.uniqueness], 'the F1x columns change no measurement the policy reads');
  const decide = async (evidence: typeof plain) => (await probeWithSeeds(client, INV_DATE, dateSeeds, bundle => attachFullEvidence(bundle, evidence, endpointsOf(INV_DATE)))).decision;
  assert.deepEqual(await decide(extended), await decide(plain));
});

test('E3-05: driven by the manifest field, F1x replaces F1 (same number of queries); without the field F1 stays', async () => {
  const client = formFixtureClient(cfg, clusteredTpcdsTables());
  const withField = await measure(client, INV_DATE, { extendedProfile: extendedProfileDeclared({ fullEvidenceExtendedProfile: true }) });
  const without = await measure(client, INV_DATE, { extendedProfile: extendedProfileDeclared({ fullEvidence: true } as never) });
  assert.ok(withField.queries.filter(query => query.form.startsWith('F1')).every(query => /concordia_avg_len/.test(query.sql)));
  assert.ok(without.queries.filter(query => query.form.startsWith('F1')).every(query => !/concordia_avg_len/.test(query.sql)));
  assert.equal(withField.queries.length, without.queries.length, 'F1x replaces F1, it adds no query');
  assert.equal(withField.source?.avgLen === undefined, false); assert.equal(without.source?.avgLen, undefined);
});
