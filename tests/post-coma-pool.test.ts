import test from 'node:test';
import assert from 'node:assert/strict';
import { runPostComa } from '../src/agent/post-coma.ts';
import { RunBudget, budgetedClient, limitsFromBounds } from '../src/agent/run-budget.ts';
import { createSourcePoolReader, type SourcePoolReader } from '../src/probe/sampling.ts';

const col = (name: string) => ({ name, type: 'string' });
// Six fact columns whose 20-row discovery sample carries ONE key (a table stored in key order), against dimensions that hold 1..50.
const factColumns = ['ss_a_sk', 'ss_b_sk', 'ss_c_sk', 'ss_d_sk', 'ss_e_sk', 'ss_f_sk'];
const dims = factColumns.map((_, i) => `dim${i}`);
const tables: Record<string, { cols: string[]; rows: string[][] }> = {
  fact: { cols: factColumns, rows: Array.from({ length: 20 }, () => factColumns.map(() => '1')) },
  ...Object.fromEntries(dims.map(d => [d, { cols: [`${d}_sk`], rows: Array.from({ length: 50 }, (_, i) => [String(i + 1)]) }]))
};
const cfg: any = { tables: Object.fromEntries(Object.entries(tables).map(([n, t]) => [n, { db: 'T', physicalTable: n, columns: t.cols.map(col), keyColumns: [], labels: [], role: 'table' }])) };
const discovery = { tables: Object.fromEntries(Object.entries(tables).map(([n, t]) => [n, { columns: t.cols, sample: { rows: t.rows } }])) };
const proposals = factColumns.map((c, i) => ({ providerId: 'p', providerVersion: '1', method: 'COMA', from: { db: 'T', table: 'fact', column: c }, to: { db: 'T', table: dims[i], column: `${dims[i]}_sk` }, rawScore: 0.9 - i / 100, reason: 'COMA_COLUMN_PAIR_OUT_OF_SCOPE', verificationStatus: 'NO VERIFICADO/UNKNOWN' as const, reviewState: 'PENDING' as const, inputHash: 'h', configHash: 'c', evidenceRefs: [] }));
const thresholds = { sustainedOverlap: 0.8, sustainedLabelAgreement: 0.8, misleadingLabelAgreement: 0.5, minDistinctKeys: 3 };
const f4Keys = ['7', '19', '33', '41'];
const reader = (calls: string[]): SourcePoolReader => ({ stats: { queries: 0, hits: 0, failures: 0 }, async widen(endpoint, sampled, minDistinctKeys) {
  const sampleDistinct = new Set(sampled.map(String)).size;
  if (sampleDistinct >= minDistinctKeys) return { keys: [...sampled], trace: { source: 'DISCOVERY_SAMPLE', reason: 'SAMPLE_SUFFICIENT', sampleDistinct, minDistinctKeys } };
  calls.push(`${endpoint.table}.${endpoint.column}`);
  return { keys: f4Keys, trace: { source: 'GLOBAL_DISTINCT_F4', reason: 'SAMPLE_BELOW_MINIMUM', sampleDistinct, minDistinctKeys, f4: { poolSize: 50, poolExhausted: false, keysPicked: 4, seed: 's', sql: 'SELECT ...', requestId: 'r-f4', queryId: 'q-f4' } } };
} });
const go = (extra: { sourcePool?: SourcePoolReader; thresholds?: any; postComa?: any } = {}) => {
  const budget = new RunBudget(limitsFromBounds({})), sqls: string[] = [];
  const client: any = { async runSql(sql: string) {
    sqls.push(sql);
    const name = dims.find(d => new RegExp(`\\b${d}\\b`).test(sql.slice(sql.indexOf(' FROM '))))!;
    return { sql, rows: tables[name].rows.filter(r => [...sql.matchAll(/'(\d+)'/g)].some(m => m[1] === r[0])), requestId: 'r', queryId: 'q', durationMs: 0, utc: 'x' };
  } };
  return runPostComa({ cfg, catalog: { postComa: { maxProbes: 10, ...extra.postComa } } as any, discovery, proposals, client: budgetedClient(client, budget) as any, budget, thresholds: extra.thresholds ?? thresholds, ...(extra.sourcePool ? { sourcePool: extra.sourcePool } : {}) }).then(report => ({ report, sqls }));
};

test('E3-07a: the six degenerate columns (20 rows, one key) probe with at least three keys and the trace shows F4', async () => {
  const before = await go();
  assert.ok(before.report.proposals.every(p => p.coverageProbe.result!.probedValues === 1 && p.coverageProbe.sampling === undefined), 'without a reader: one key, as today');
  const calls: string[] = [];
  const { report, sqls } = await go({ sourcePool: reader(calls) });
  assert.equal(calls.length, 6); assert.equal(sqls.length, 6, 'the reader is injected; the probes themselves stay one SQL each');
  for (const p of report.proposals) {
    assert.ok(p.coverageProbe.result!.probedValues >= 3, p.proposalId);
    assert.deepEqual([p.coverageProbe.sampling!.source, p.coverageProbe.sampling!.f4!.queryId], ['GLOBAL_DISTINCT_F4', 'q-f4']);
    assert.ok(f4Keys.every(key => p.coverageProbe.sql!.includes(`'${key}'`)), 'the probe SQL carries the widened keys');
    assert.equal(p.verificationStatus, 'NO VERIFICADO/UNKNOWN');
  }
});

test('E3-07a: a sufficient sample is not replaced; without minDistinctKeys the reader is not consulted', async () => {
  const rich = { ...discovery.tables };
  const calls: string[] = [];
  const pool = reader(calls);
  await go({ sourcePool: pool, thresholds: { ...thresholds, minDistinctKeys: 1 } });
  assert.equal(calls.length, 0, 'one distinct key already meets a minimum of one');
  await go({ sourcePool: pool, thresholds: { sustainedOverlap: 0.8, sustainedLabelAgreement: 0.8, misleadingLabelAgreement: 0.5 } });
  assert.equal(calls.length, 0, 'no declared minimum: nothing is invented');
  assert.ok(rich);
});

test('E3-07a: with the real reader a failed F4 leaves the sample and says why', async () => {
  const failing: any = { async runSql() { throw Object.assign(new Error('x'), { code: 'F4_DOWN' }); } };
  const { report } = await go({ sourcePool: createSourcePoolReader({ client: failing, cfg, scope: 'test' }) });
  assert.ok(report.proposals.every(p => p.coverageProbe.sampling!.reason === 'F4_FAILED' && p.coverageProbe.sampling!.source === 'DISCOVERY_SAMPLE' && p.coverageProbe.result!.probedValues === 1));
});

test('E3-07a: the pre-estimate grows by exactly one F4 read per degenerate source column, in both modes', async () => {
  for (const postComa of [{}, { coverAll: true }]) {
    const plain = await go({ postComa }), withPool = await go({ sourcePool: reader([]), postComa });
    assert.equal(plain.report.policy.estimatedQueries, 6);
    assert.equal(withPool.report.policy.estimatedQueries - plain.report.policy.estimatedQueries, 6, JSON.stringify(postComa));
    assert.equal(withPool.report.policy.f4Reads, 6);
  }
  const sufficient = await go({ sourcePool: reader([]), thresholds: { ...thresholds, minDistinctKeys: 1 } });
  assert.equal(sufficient.report.policy.estimatedQueries, 6); assert.equal(sufficient.report.policy.f4Reads, undefined);
  const capped = await go({ sourcePool: reader([]), postComa: { maxProbes: 2 } });
  assert.deepEqual([capped.report.policy.estimatedQueries, capped.report.policy.f4Reads], [4, 2], 'only the columns the cap will probe are counted');
});

test('E3-07a: the diagnostic counts the F4 keys that were tested, with their basis; fewer than the minimum stays deferred; the normal case keeps the sample', async () => {
  const { report } = await go({ sourcePool: reader([]) });
  for (const p of report.proposals) { const m = p.coverageProbe.diagnostic!.multiplicity.from; assert.deepEqual([m.distinctKeys, m.fromBasis], [4, 'GLOBAL_DISTINCT_F4']); }
  const few: SourcePoolReader = { stats: { queries: 0, hits: 0, failures: 0 }, async widen(_e, sampled, minDistinctKeys) { return { keys: [...sampled], trace: { source: 'DISCOVERY_SAMPLE', reason: 'F4_FAILED', sampleDistinct: 1, minDistinctKeys } }; } };
  const failed = await go({ sourcePool: few });
  assert.ok(failed.report.proposals.every(p => p.coverageProbe.diagnostic!.multiplicity.from.distinctKeys === 1 && p.coverageProbe.diagnostic!.multiplicity.from.fromBasis === 'DISCOVERY_SAMPLE'));
  const plain = await go();
  assert.ok(plain.report.proposals.every(p => p.coverageProbe.diagnostic!.multiplicity.from.fromBasis === 'DISCOVERY_SAMPLE'));
});

test('C5: with coverAll a prior run never skips a probe; without it the demonstrated pairs are still skipped', async () => {
  const scope = { universeId: 'T', executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' } as any;
  const prior = { scope, pairs: proposals.map(p => ({ from: p.from, to: p.to, outcome: 'ACCEPTED' })) } as any;
  const run = async (postComa: any) => {
    const budget = new RunBudget(limitsFromBounds({})), sqls: string[] = [];
    const client: any = { async runSql(sql: string) { sqls.push(sql); return { sql, rows: [['1']], requestId: 'r', queryId: 'q', durationMs: 0, utc: 'x' }; } };
    const report = await runPostComa({ cfg, catalog: { postComa: { maxProbes: 10, ...postComa } } as any, discovery, proposals, client: budgetedClient(client, budget) as any, budget, thresholds, prior, scope });
    return { report, sqls };
  };
  const plain = await run({});
  assert.equal(plain.sqls.length, 0); assert.equal(plain.report.priorRun!.skipped.length, 6);
  const all = await run({ coverAll: true });
  assert.equal(all.sqls.length, 6, 'coverAll probes every pair, demonstrated or not');
  assert.ok(all.report.proposals.every(p => p.coverageProbe.status === 'EXECUTED' && p.coverageProbe.reason !== 'PRIOR_RUN_DEMONSTRATED'));
  assert.equal(all.report.priorRun!.skipped.length, 0);
});
