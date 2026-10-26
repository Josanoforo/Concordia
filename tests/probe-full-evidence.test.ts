import test from 'node:test';
import assert from 'node:assert/strict';
import { isFullEvidenceSql } from '../src/clients/zetaris.ts';
import { zetarisTableSpecs } from '../src/relations/adapters/zetaris.ts';
import { evaluateRelation } from '../src/relations/decision.ts';
import { attachFullEvidence, duplicateKeysSql, FULL_EVIDENCE_MAX_QUERIES, FULL_EVIDENCE_MIN_QUERIES, measureFullEvidence, missingCountSql, missingSampleSql, profileSql, type FullEvidenceEndpoint } from '../src/probe/full-evidence.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { formFixtureClient } from './helpers/form-fixture-client.ts';
import { clusteredTpcdsTables, M12_RELATIONS, probeWithSeeds } from './helpers/tpcds-clustered.ts';

const cfg = universeConfig('TPCDS'), specs = zetarisTableSpecs(cfg);
const WAREHOUSE = M12_RELATIONS[0];
const CHECKED_AT = '2026-10-25T00:00:00.000Z';
function endpointsOf(relation: (typeof M12_RELATIONS)[number], types?: { from?: string | null; to?: string | null }): { from: FullEvidenceEndpoint; to: FullEvidenceEndpoint } {
  const one = (side: 'from' | 'to'): FullEvidenceEndpoint => {
    const endpoint = relation[side], column = (cfg.tables[endpoint.table].columns as { name: string; type: string }[]).find(item => item.name === endpoint.column);
    const type = types && side in types ? types[side] : column?.type;
    return { table: endpoint.table, column: endpoint.column, type: type ?? undefined, spec: specs[endpoint.table], sourceId: `${endpoint.db}:${endpoint.table}:${side}` };
  };
  return { from: one('from'), to: one('to') };
}
const measure = (client: unknown, relation = WAREHOUSE, extra: Partial<Parameters<typeof measureFullEvidence>[0]> = {}, types?: Parameters<typeof endpointsOf>[1]) =>
  measureFullEvidence({ client: client as any, relationId: relation.id, ...endpointsOf(relation, types), checkedAt: CHECKED_AT, ...extra });
const seeds = [1, 2, 3, 4, 5];
async function decide(tables = clusteredTpcdsTables(), options: { relation?: (typeof M12_RELATIONS)[number]; measure?: Partial<Parameters<typeof measureFullEvidence>[0]>; attach?: boolean; sampleSeeds?: (string | number)[]; policy?: { minimumOverlapRatio?: number } } = {}) {
  const log: string[] = [], client = formFixtureClient(cfg, tables, log), relation = options.relation ?? WAREHOUSE;
  const evidence = await measure(client, relation, options.measure);
  const probed = await probeWithSeeds(client, relation, options.sampleSeeds ?? seeds, bundle => { if (options.attach !== false) attachFullEvidence(bundle, evidence, endpointsOf(relation)); });
  const decision = options.policy ? evaluateRelation(probed.contract, [probed.execution.bundle], { policyVersion: '1.0', minimumDistinctKeys: 3, ...options.policy }) : probed.decision;
  return { evidence, decision, probed, log };
}

test('every full-evidence statement is a closed form accepted by the real read guard; sample limits are bounded', () => {
  const { from, to } = endpointsOf(WAREHOUSE);
  for (const sql of [profileSql(from), profileSql(to), duplicateKeysSql(to, 20), missingCountSql(from, to), missingSampleSql(from, to, 20)]) assert.ok(isFullEvidenceSql(sql), sql);
  assert.equal(profileSql(to), 'SELECT COUNT(*) AS concordia_rows, COUNT(DISTINCT w_warehouse_sk) AS concordia_distinct, SUM(CASE WHEN w_warehouse_sk IS NULL THEN 1 ELSE 0 END) AS concordia_nulls FROM (SELECT w_warehouse_sk, w_warehouse_id, w_warehouse_name FROM TPCDS_DB.warehouse) concordia_source');
  assert.equal(missingCountSql(from, to), 'SELECT COUNT(*) AS concordia_missing FROM (SELECT DISTINCT inv_warehouse_sk AS k FROM (SELECT inv_date_sk, inv_item_sk, inv_warehouse_sk FROM TPCDS_DB.inventory) concordia_source WHERE inv_warehouse_sk IS NOT NULL) concordia_s LEFT JOIN (SELECT DISTINCT w_warehouse_sk AS k FROM (SELECT w_warehouse_sk, w_warehouse_id, w_warehouse_name FROM TPCDS_DB.warehouse) concordia_source) concordia_t ON concordia_s.k = concordia_t.k WHERE concordia_t.k IS NULL');
  assert.throws(() => duplicateKeysSql(to, 51), /FULL_EVIDENCE_SAMPLE_LIMIT_OUT_OF_RANGE/); assert.throws(() => missingSampleSql(from, to, 0), /FULL_EVIDENCE_SAMPLE_LIMIT_OUT_OF_RANGE/);
  assert.throws(() => profileSql({ ...from, column: 'x; DROP' }), /INVALID_SQL_IDENTIFIER/);
});

test('P3: complete coverage and a unique target turn both caveats into measurements: SOSTENIDA with nothing missing, in 3 queries', async () => {
  const { evidence, decision, log } = await decide();
  assert.equal(evidence.coverage.status, 'MEASURED'); assert.deepEqual(evidence.coverage.status === 'MEASURED' && [evidence.coverage.sourceDistinct, evidence.coverage.missing, evidence.coverage.complete], [5, 0, true]);
  assert.equal(evidence.uniqueness.status === 'MEASURED' && evidence.uniqueness.unique, true);
  assert.deepEqual(evidence.queries.map(query => query.form), ['F1_TARGET', 'F1_SOURCE', 'F3B']); assert.equal(evidence.queries.length, FULL_EVIDENCE_MIN_QUERIES);
  assert.ok(evidence.queries.every(query => query.ok && query.requestId && query.queryId));
  assert.equal(log.filter(sql => /concordia_(rows|missing)/.test(sql)).length, 3);
  assert.equal(decision.verdict, 'SOSTENIDA');
  assert.deepEqual(decision.requirementsMissing, []);
  assert.ok(decision.requirementsMet.includes('global_coverage_established') && decision.requirementsMet.includes('global_uniqueness_established'));
  assert.ok(decision.reasonCodes.includes('global_coverage_measured_complete') && decision.reasonCodes.includes('global_target_uniqueness_measured'));
  assert.match((decision.scope as any).value, /whole-table coverage and target uniqueness measured/);
});

test('P3: without a measurement the caveat stays, and the decision is the bounded one byte for byte', async () => {
  const tables = clusteredTpcdsTables();
  const bounded = await decide(tables, { attach: false });
  assert.deepEqual(bounded.decision.requirementsMissing, ['global_coverage_not_established', 'global_uniqueness_not_established']);
  assert.equal((bounded.decision.scope as any).value, 'bounded observed sample only; no global coverage or uniqueness claim');
  const failing = { async runSql() { throw Object.assign(new Error('x'), { code: 'AGENT_QUERY_BUDGET_EXHAUSTED' }); } };
  const none = await measure(failing);
  assert.equal(none.coverage.status, 'NOT_MEASURED'); assert.equal(none.uniqueness.status, 'NOT_MEASURED');
  assert.deepEqual(none.queries.map(query => [query.form, query.ok, query.errorCode]), [['F1_TARGET', false, 'AGENT_QUERY_BUDGET_EXHAUSTED'], ['F1_SOURCE', false, 'AGENT_QUERY_BUDGET_EXHAUSTED']]);
  const probed = await probeWithSeeds(formFixtureClient(cfg, tables), WAREHOUSE, seeds, bundle => assert.deepEqual(attachFullEvidence(bundle, none, endpointsOf(WAREHOUSE)), []));
  assert.deepEqual(probed.decision, bounded.decision, 'NOT_MEASURED adds no observation and changes nothing');
});

test('P3: a failed F3b leaves coverage unestablished but still establishes uniqueness (each caveat follows its own measurement)', async () => {
  const tables = clusteredTpcdsTables(), inner = formFixtureClient(cfg, tables);
  const client = { async runSql(sql: string, limit?: number) { if (/concordia_missing/.test(sql)) throw Object.assign(new Error('x'), { code: 'TIMEOUT' }); return inner.runSql(sql, limit); } };
  const evidence = await measure(client);
  assert.deepEqual(evidence.coverage, { status: 'NOT_MEASURED', reason: 'TIMEOUT', detail: 'F3B' }, 'a timeout is named as such (C3)'); assert.equal(evidence.uniqueness.status, 'MEASURED');
  const refused = { async runSql(sql: string, limit?: number) { if (/concordia_missing/.test(sql)) throw Object.assign(new Error('x'), { code: 'HTTP_ERROR' }); return inner.runSql(sql, limit); } };
  assert.deepEqual((await measure(refused)).coverage, { status: 'NOT_MEASURED', reason: 'QUERY_FAILED', detail: 'F3B' }, 'any other failure stays QUERY_FAILED');
  const probed = await probeWithSeeds(inner, WAREHOUSE, seeds, bundle => attachFullEvidence(bundle, evidence, endpointsOf(WAREHOUSE)));
  assert.equal(probed.decision.verdict, 'SOSTENIDA'); assert.deepEqual(probed.decision.requirementsMissing, ['global_coverage_not_established']);
  assert.ok(probed.decision.requirementsMet.includes('global_uniqueness_established'));
});

test('P3: source keys missing from the whole target are invisible to the sample but ENGAÑOSA once measured globally (3 of 8 is below the policy overlap of 0.8)', async () => {
  const tables = clusteredTpcdsTables();
  for (const [row, warehouse] of [[31, 7], [32, 8], [33, 9]]) tables.inventory.rows[row][2] = warehouse; // warehouses 7, 8, 9 do not exist; the probe seeds below never include them
  const sampleOnly = await decide(tables, { attach: false, sampleSeeds: [1, 2, 3] });
  assert.equal(sampleOnly.decision.verdict, 'SOSTENIDA', 'the bounded sample alone cannot see it');
  const { evidence, decision } = await decide(tables, { sampleSeeds: [1, 2, 3], measure: { sampleMissingKeys: true } });
  assert.deepEqual(evidence.coverage.status === 'MEASURED' && [evidence.coverage.sourceDistinct, evidence.coverage.missing, evidence.coverage.complete, evidence.coverage.missingSample], [8, 3, false, ['7', '8', '9']]);
  assert.ok(evidence.queries.some(query => query.form === 'F3A'));
  assert.equal(decision.verdict, 'ENGAÑOSA'); assert.deepEqual(decision.reasonCodes, ['global_source_keys_missing_from_target']); assert.deepEqual(decision.contradictions, ['global_source_key_absent_from_target']);
  assert.deepEqual(decision.requirementsMissing, []);
});

test('P3: a policy overlap ratio is applied to the global ratio exactly as to the sample ratio; partial coverage keeps its caveat', async () => {
  const tables = clusteredTpcdsTables();
  tables.inventory.rows[33][2] = 9;
  const tolerant = await decide(tables, { sampleSeeds: [1, 2, 3], policy: { minimumOverlapRatio: 0.8 } });
  assert.equal(tolerant.decision.verdict, 'SOSTENIDA'); assert.ok(tolerant.decision.reasonCodes.includes('global_coverage_measured_partial'));
  assert.ok(tolerant.decision.requirementsMissing.includes('global_coverage_not_established') && !tolerant.decision.requirementsMissing.includes('global_uniqueness_not_established'));
  const strict = await decide(tables, { sampleSeeds: [1, 2, 3], policy: { minimumOverlapRatio: 0.9 } });
  assert.equal(strict.decision.verdict, 'ENGAÑOSA');
});

test('P3: a target that repeats a key is INDETERMINADA global_target_keys_not_unique, with the duplicated keys sampled by F2', async () => {
  const tables = clusteredTpcdsTables();
  tables.warehouse.rows.push([3, 'WA0003', 'Depot 3 (again)']);
  const { evidence, decision } = await decide(tables);
  assert.deepEqual(evidence.uniqueness.status === 'MEASURED' && [evidence.uniqueness.rows, evidence.uniqueness.distinct, evidence.uniqueness.unique, evidence.uniqueness.duplicateSample], [6, 5, false, [{ key: '3', count: 2 }]]);
  assert.deepEqual(evidence.queries.map(query => query.form), ['F1_TARGET', 'F2', 'F1_SOURCE', 'F3B']); assert.ok(evidence.queries.length <= FULL_EVIDENCE_MAX_QUERIES);
  assert.equal(decision.verdict, 'INDETERMINADA'); assert.deepEqual(decision.reasonCodes, ['global_target_keys_not_unique']); assert.deepEqual(decision.requirementsMissing, ['unique_referenced_keys']);
});

test('P3: NULL target keys do not count as duplicates (rows - nulls = distinct)', async () => {
  const tables = clusteredTpcdsTables();
  tables.warehouse.rows.push([null, 'WA0009', 'no key']);
  const { evidence, decision } = await decide(tables);
  assert.deepEqual(evidence.uniqueness.status === 'MEASURED' && [evidence.uniqueness.rows, evidence.uniqueness.distinct, evidence.uniqueness.nulls, evidence.uniqueness.unique], [6, 5, 1, true]);
  assert.equal(decision.verdict, 'SOSTENIDA');
});

test('P3: different or unknown declared types are NOT_MEASURED with no query at all (never a CAST), and the caveats stay', async () => {
  const log: string[] = [], client = formFixtureClient(cfg, clusteredTpcdsTables(), log);
  const mismatch = await measure(client, WAREHOUSE, {}, { to: 'string' });
  assert.deepEqual([mismatch.coverage, mismatch.uniqueness], [{ status: 'NOT_MEASURED', reason: 'TYPE_MISMATCH', detail: 'integer/string' }, { status: 'NOT_MEASURED', reason: 'TYPE_MISMATCH', detail: 'integer/string' }]);
  const unknown = await measure(client, WAREHOUSE, {}, { from: null });
  assert.equal(unknown.coverage.status === 'NOT_MEASURED' && unknown.coverage.reason, 'TYPE_UNKNOWN');
  assert.deepEqual([mismatch.queries.length, unknown.queries.length, log.length], [0, 0, 0]);
  const probed = await probeWithSeeds(client, WAREHOUSE, seeds, bundle => assert.deepEqual(attachFullEvidence(bundle, mismatch, endpointsOf(WAREHOUSE)), []));
  assert.deepEqual(probed.decision.requirementsMissing, ['global_coverage_not_established', 'global_uniqueness_not_established']);
});

test('P3: an empty source or a column outside the configured allowlist is NOT_MEASURED', async () => {
  const tables = clusteredTpcdsTables(); tables.inventory.rows = [];
  const empty = await measure(formFixtureClient(cfg, tables));
  assert.equal(empty.coverage.status === 'NOT_MEASURED' && empty.coverage.reason, 'SOURCE_EMPTY'); assert.equal(empty.uniqueness.status, 'MEASURED', 'target uniqueness does not depend on the source');
  const outside = endpointsOf(WAREHOUSE); outside.from.column = 'inv_unlisted';
  const result = await measureFullEvidence({ client: formFixtureClient(cfg, clusteredTpcdsTables()) as any, relationId: 'x', ...outside, checkedAt: CHECKED_AT });
  assert.equal(result.coverage.status === 'NOT_MEASURED' && result.coverage.reason, 'COLUMN_OUTSIDE_CONFIG'); assert.equal(result.queries.length, 0);
});

test('P3: a malformed answer is not a measurement', async () => {
  const inner = formFixtureClient(cfg, clusteredTpcdsTables());
  const bad = (pattern: RegExp, rows: unknown[][]) => ({ async runSql(sql: string, limit?: number) { const answer = await inner.runSql(sql, limit); return pattern.test(sql) ? { ...answer, rows } : answer; } });
  const profile = await measure(bad(/concordia_rows/, [['six', 5, 0]]));
  assert.deepEqual([profile.coverage.status, profile.uniqueness.status], ['NOT_MEASURED', 'NOT_MEASURED']);
  const impossible = await measure(bad(/concordia_missing/, [[99]]));
  assert.deepEqual(impossible.coverage, { status: 'NOT_MEASURED', reason: 'MALFORMED_RESPONSE', detail: 'F3B' });
});

test('decision: forged or misplaced global observations are ignored and reported; the caveats stay', async () => {
  const tables = clusteredTpcdsTables(), client = formFixtureClient(cfg, tables), evidence = await measure(client);
  const forge = async (mutate: (observation: any) => void) => {
    const probed = await probeWithSeeds(client, WAREHOUSE, seeds, bundle => { attachFullEvidence(bundle, evidence, endpointsOf(WAREHOUSE)); mutate(bundle.observations.find(item => item.type === 'GLOBAL_COVERAGE')); });
    return probed.decision;
  };
  for (const [name, mutate] of [
    ['wrong endpoint', (o: any) => { o.sourceRef = 'TPCDS_DB:warehouse:to'; }], ['missing above distinct', (o: any) => { o.measuredTuples = [[5, 9]]; }],
    ['negative count', (o: any) => { o.measuredTuples = [[5, -1]]; }], ['not an integer', (o: any) => { o.measuredTuples = [[5, 0.5]]; }], ['truncated', (o: any) => { o.truncated = true; }],
    ['wrong projection', (o: any) => { o.projection = ['missing', 'sourceDistinct']; }], ['zero distinct', (o: any) => { o.measuredTuples = [[0, 0]]; }]
  ] as const) {
    const decision = await forge(mutate);
    if (name === 'truncated') { assert.equal(decision.verdict, 'INDETERMINADA', name); continue; }
    assert.equal(decision.verdict, 'SOSTENIDA', name); assert.ok(decision.requirementsMissing.includes('global_coverage_not_established'), name); assert.ok(decision.reasonCodes.includes('global_evidence_malformed_ignored'), name);
    assert.ok(decision.requirementsMet.includes('global_uniqueness_established'), `${name}: the valid dimension still counts`);
  }
});

test('decision: global evidence never rescues a sample verdict that was not SOSTENIDA', async () => {
  const tables = clusteredTpcdsTables();
  const { decision } = await decide(tables, { sampleSeeds: [1, 2] });
  assert.deepEqual([decision.verdict, decision.reasonCodes[0]], ['INDETERMINADA', 'insufficient_distinct_sample_keys']);
  tables.inventory.rows[33][2] = 9;
  const missingSample = await decide(tables, { sampleSeeds: [1, 2, 3, 9] });
  assert.equal(missingSample.decision.verdict, 'ENGAÑOSA'); assert.deepEqual(missingSample.decision.reasonCodes, ['observed_key_missing_from_referenced_sample']);
});
