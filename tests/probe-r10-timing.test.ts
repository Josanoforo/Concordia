import test from 'node:test';
import assert from 'node:assert/strict';
import { limitsFromBounds, RunBudget } from '../src/agent/run-budget.ts';
import { measureTieEvidence } from '../src/agent/tie-evidence.ts';
import { SafeError } from '../src/runtime.ts';
import { zetarisTableSpecs } from '../src/relations/adapters/zetaris.ts';
import { createProfileCache, measureColumnProfile, type ColumnProfile } from '../src/probe/column-profile.ts';
import { attachFullEvidence, measureFullEvidence, type FullEvidenceEndpoint } from '../src/probe/full-evidence.ts';
import { createGlobalTiming, globalTimingDeclared, GLOBAL_TIMEOUT_MAX_MS } from '../src/probe/global-timing.ts';
import { createSourcePoolReader } from '../src/probe/sampling.ts';
import { universeConfig } from '../src/universe-pipeline.ts';
import { formFixtureClient } from './helpers/form-fixture-client.ts';
import { clusteredTpcdsTables, M12_RELATIONS, probeWithSeeds } from './helpers/tpcds-clustered.ts';

/**
 * R10 live, correction C3: five Zetaris TIMEOUTs at 60 s. F1x over a small dimension (web_page) and a coverage read over store were transient stalls; the other three were
 * global-evidence reads over large fact tables (F4 on store_returns and catalog_returns, the anti-join of store_sales against customer).
 */
const cfg = universeConfig('TPCDS'), specs = zetarisTableSpecs(cfg), CHECKED_AT = '2026-10-25T00:00:00.000Z';
type Relation = (typeof M12_RELATIONS)[number];
const [WAREHOUSE, INV_DATE] = M12_RELATIONS;
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
const timeout = () => new SafeError('TIMEOUT');

/** The fixture client behind a wrapper that records every call (sql + options) and throws a TIMEOUT where `slow` says so. */
function wrapped(slow: (sql: string) => boolean, delayMs = 0) {
  const inner = formFixtureClient(cfg, clusteredTpcdsTables()), calls: { sql: string; options: unknown }[] = [];
  const client = { async runSql(sql: string, limit?: number, options?: unknown) {
    calls.push({ sql, options });
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    if (slow(sql)) throw timeout();
    return inner.runSql(sql, limit);
  } };
  return { client, calls };
}
const isF1x = (sql: string) => /concordia_min/.test(sql);
const isF3b = (sql: string) => /concordia_missing\b/.test(sql);

// ---------------------------------------------------------------- F1x falls back to F1 on a timeout

test('C3: an F1x that times out is retried ONCE as F1; the profile says it is not extended, both attempts are reported, and the run never pays that timeout again', async () => {
  const { client, calls } = wrapped(isF1x), cache = createProfileCache();
  const first = await profileOf(client, 'warehouse', 'w_warehouse_sk', { cache, extended: true });
  const profile = measuredOnly(first.profile);
  assert.deepEqual([profile.form, profile.fellBackFrom, profile.rows, profile.distinct, profile.min, profile.max, profile.avgLen], ['F1', 'F1x', 5, 5, undefined, undefined, undefined]);
  assert.deepEqual([first.failed?.form, first.failed?.ok, first.failed?.errorCode], ['F1x', false, 'TIMEOUT']);
  assert.deepEqual([first.query.form, first.query.ok], ['F1', true]);
  assert.equal(calls.length, 2); assert.equal(cache.stats.queries, 2, 'both attempts were sent, both are counted');
  // Every later extended request of the column (another relation of the run) is served by that F1: no query at all.
  const again = await profileOf(client, 'warehouse', 'w_warehouse_sk', { cache, extended: true });
  assert.equal(again.query.cached, true); assert.equal(measuredOnly(again.profile).fellBackFrom, 'F1x'); assert.equal(again.failed, undefined);
  assert.equal(calls.length, 2); assert.equal(cache.stats.hits, 1);
  // Another column is not affected: its F1x works.
  const other = measuredOnly((await profileOf(client, 'date_dim', 'd_date_sk', { cache: createProfileCache(), extended: false })).profile);
  assert.equal(other.form, 'F1');
});

test('C3: if the F1 fallback fails too the column is NOT_MEASURED (TIMEOUT) with the failed F1x reported, and the next request tries F1 directly (one attempt)', async () => {
  const { client, calls } = wrapped(() => true), cache = createProfileCache();
  const first = await profileOf(client, 'warehouse', 'w_warehouse_sk', { cache, extended: true });
  assert.deepEqual([first.profile.provenance, first.profile.provenance === 'NOT_MEASURED' && first.profile.reason, first.failed?.form, first.query.form], ['NOT_MEASURED', 'TIMEOUT', 'F1x', 'F1']);
  assert.equal(calls.length, 2); assert.equal(cache.entries.size, 0);
  const next = await profileOf(client, 'warehouse', 'w_warehouse_sk', { cache, extended: true });
  assert.equal(calls.length, 3, 'the F1x is not asked again after it timed out');
  assert.equal(next.query.form, 'F1'); assert.equal(next.failed, undefined);
});

test('C3: a plain F1 that times out is not retried, and a non-timeout failure of an F1x does not fall back', async () => {
  const f1 = wrapped(() => true);
  const result = await profileOf(f1.client, 'warehouse', 'w_warehouse_sk', { cache: createProfileCache() });
  assert.deepEqual([result.profile.provenance === 'NOT_MEASURED' && result.profile.reason, f1.calls.length, result.failed], ['TIMEOUT', 1, undefined]);
  const inner = formFixtureClient(cfg, clusteredTpcdsTables());
  let calls = 0;
  const refused = { async runSql(sql: string, limit?: number) { calls++; if (isF1x(sql)) throw new SafeError('HTTP_ERROR', 500); return inner.runSql(sql, limit); } };
  const failed = await profileOf(refused, 'warehouse', 'w_warehouse_sk', { cache: createProfileCache(), extended: true });
  assert.deepEqual([failed.profile.provenance === 'NOT_MEASURED' && failed.profile.reason, calls, failed.failed], ['QUERY_FAILED', 1, undefined]);
});

test('C3: measureFullEvidence with the extended profile survives an F1x timeout: both coverage and uniqueness are measured from the F1 counts, and the report lists the failed F1x', async () => {
  const { client } = wrapped(isF1x), evidence = await measure(client, WAREHOUSE, { extendedProfile: true, cache: createProfileCache() });
  assert.equal(evidence.coverage.status, 'MEASURED'); assert.equal(evidence.uniqueness.status, 'MEASURED');
  assert.equal(evidence.target?.min, undefined); assert.equal(evidence.source?.min, undefined);
  const target = evidence.queries.filter(query => query.form === 'F1_TARGET'), source = evidence.queries.filter(query => query.form === 'F1_SOURCE');
  assert.deepEqual(target.map(query => [query.ok, query.errorCode ?? null]), [[false, 'TIMEOUT'], [true, null]]);
  assert.deepEqual(source.map(query => query.ok), [false, true]);
  const bundle = { observations: [] as any[], sourceRefs: [], evidenceBundleId: 'x' } as any;
  assert.deepEqual(attachFullEvidence(bundle, evidence, endpointsOf(WAREHOUSE)), ['GLOBAL_COVERAGE', 'GLOBAL_UNIQUENESS'].map(name => bundle.observations.find((item: any) => item.type.includes(name))?.type));
  assert.ok(bundle.observations.every((item: any) => !/F1x/.test(item.filters.join())), 'only the successful queries are cited as the basis of the observation');
});

// ---------------------------------------------------------------- the time policy of global evidence

test('C3: the policy gives every global-evidence read its own timeout; without a policy no third argument is passed (the client default, as before)', async () => {
  const none = wrapped(() => false);
  await measure(none.client, WAREHOUSE);
  assert.ok(none.calls.every(call => call.options === undefined));
  const timed = wrapped(() => false), timing = createGlobalTiming({ queryTimeoutMs: GLOBAL_TIMEOUT_MAX_MS });
  await measure(timed.client, WAREHOUSE, { timing });
  assert.ok(timed.calls.length >= 3 && timed.calls.every(call => JSON.stringify(call.options) === JSON.stringify({ timeoutMs: GLOBAL_TIMEOUT_MAX_MS })));
  assert.equal(timing.state.sent, timed.calls.length); assert.equal(timing.state.timedOut, 0);
});

test('C3: after maxTimeoutsPerTable timeouts a table is not read again: the skipped reads are not sent, are listed, and the dimension says TIME_BUDGET_EXHAUSTED (the caveat stays)', async () => {
  const { client, calls } = wrapped(isF3b), timing = createGlobalTiming({ maxTimeoutsPerTable: 1 }), cache = createProfileCache();
  const first = await measure(client, WAREHOUSE, { timing, cache });
  assert.deepEqual(first.coverage, { status: 'NOT_MEASURED', reason: 'TIMEOUT', detail: 'F3B' });
  assert.equal(first.uniqueness.status, 'MEASURED');
  assert.equal(timing.state.timeouts.get('inventory'), 1); assert.equal(timing.state.timeouts.get('warehouse'), 1);
  const before = calls.length;
  // A second relation over the same source table: the heavy read is skipped, no query goes out for it.
  const second = await measure(client, INV_DATE, { timing, cache });
  assert.equal(second.coverage.status === 'NOT_MEASURED' && second.coverage.reason, 'TIME_BUDGET_EXHAUSTED');
  assert.equal(calls.slice(before).filter(call => isF3b(call.sql)).length, 0, 'the anti-join over the timed-out table is not sent again');
  assert.equal(timing.state.skipped > 0, true);
});

test('C3: the run time budget stops the remaining global reads once spent; what was measured before stays', async () => {
  const { client, calls } = wrapped(() => false, 15), timing = createGlobalTiming({ budgetMs: 5 });
  const evidence = await measure(client, WAREHOUSE, { timing });
  assert.equal(calls.length, 1, 'the first read spends the budget; nothing else is sent');
  assert.equal(evidence.uniqueness.status === 'MEASURED', true, 'the first read (F1 of the target) completed');
  assert.equal(evidence.coverage.status === 'NOT_MEASURED' && evidence.coverage.reason, 'TIME_BUDGET_EXHAUSTED');
  assert.ok(timing.state.spentMs >= 5 && timing.state.skipped >= 1);
  const gone = await measure(client, INV_DATE, { timing });
  assert.deepEqual([gone.uniqueness.status === 'NOT_MEASURED' && gone.uniqueness.reason, calls.length], ['TIME_BUDGET_EXHAUSTED', 1]);
});

test('C3: the F1 fallback ignores the per-table limit but not the run budget', async () => {
  const limited = wrapped(isF1x), timing = createGlobalTiming({ maxTimeoutsPerTable: 1 });
  const fine = await profileOf(limited.client, 'warehouse', 'w_warehouse_sk', { cache: createProfileCache(), extended: true, timing });
  assert.equal(measuredOnly(fine.profile).fellBackFrom, 'F1x', 'one timeout reached the limit of 1 and the fallback still ran');
  const broke = wrapped(isF1x, 12), budget = createGlobalTiming({ budgetMs: 5 });
  const stopped = await profileOf(broke.client, 'warehouse', 'w_warehouse_sk', { cache: createProfileCache(), extended: true, timing: budget });
  assert.deepEqual([stopped.profile.provenance === 'NOT_MEASURED' && stopped.profile.reason, broke.calls.length, stopped.failed], ['TIMEOUT', 1, undefined]);
});

test('C3: the F4 source pool read obeys the policy: a timeout leaves the sample and is traced; a blocked table is not read at all', async () => {
  const tables = clusteredTpcdsTables(), inner = formFixtureClient(cfg, tables);
  const target = { table: 'inventory', column: 'inv_warehouse_sk' }, sample = [1], calls: string[] = [];
  const client = { async runSql(sql: string, limit?: number, options?: unknown) { calls.push(JSON.stringify(options ?? null)); if (/SELECT DISTINCT/.test(sql)) throw timeout(); return inner.runSql(sql, limit); } };
  const timing = createGlobalTiming({ queryTimeoutMs: 90_000, maxTimeoutsPerTable: 1 });
  const reader = createSourcePoolReader({ client: client as any, cfg, scope: 's', timing });
  const widened = await reader.widen(target, sample, 3);
  assert.deepEqual([widened.keys, widened.trace.source, widened.trace.reason, widened.trace.failureCode], [sample, 'DISCOVERY_SAMPLE', 'F4_FAILED', 'TIMEOUT']);
  assert.match(calls[0], /"timeoutMs":90000/); assert.match(calls[0], /"limitCeiling":100/, 'the F4 ceiling is kept next to the new timeout');
  const other = await createSourcePoolReader({ client: client as any, cfg, scope: 's', timing }).widen({ table: 'inventory', column: 'inv_date_sk' }, sample, 3);
  assert.equal(other.trace.failureCode, 'TIME_BUDGET_EXHAUSTED'); assert.equal(calls.length, 1, 'inventory already timed out once: the second F4 over it is not sent');
});

// ---------------------------------------------------------------- policy declaration

test('C3: the policy is declared in the manifest by three optional fields; none declared means no timing; an invalid value is refused', () => {
  assert.equal(globalTimingDeclared(undefined), undefined); assert.equal(globalTimingDeclared({}), undefined);
  const declared = globalTimingDeclared({ fullEvidenceTimeoutMs: 90_000, fullEvidenceBudgetMs: 600_000, fullEvidenceMaxTimeoutsPerTable: 3 })!;
  assert.deepEqual(declared.policy, { queryTimeoutMs: 90_000, budgetMs: 600_000, maxTimeoutsPerTable: 3 });
  assert.equal(globalTimingDeclared({ fullEvidenceBudgetMs: 1000 })!.policy.maxTimeoutsPerTable, 2, 'two timeouts per table by default');
  assert.throws(() => globalTimingDeclared({ fullEvidenceTimeoutMs: 120_001 }), /GLOBAL_TIMEOUT_MS_INVALID/);
  assert.throws(() => globalTimingDeclared({ fullEvidenceTimeoutMs: '60000' }), /GLOBAL_TIMEOUT_MS_INVALID/);
  assert.throws(() => globalTimingDeclared({ fullEvidenceBudgetMs: 0 }), /GLOBAL_TIME_BUDGET_MS_INVALID/);
  assert.throws(() => globalTimingDeclared({ fullEvidenceMaxTimeoutsPerTable: 0 }), /GLOBAL_MAX_TIMEOUTS_PER_TABLE_INVALID/);
});

test('C3: tie evidence reports a timeout as TIMEOUT and counts the two queries of an F1x fallback', async () => {
  const proposals = ['warehouse', 'date_dim'].map(name => ({ proposalId: `p-${name}`, from: { table: 'inventory', column: 'inv_warehouse_sk' }, to: { table: name, column: name === 'warehouse' ? 'w_warehouse_sk' : 'd_date_sk' }, coverageProbe: { status: 'EXECUTED', diagnostic: { coverage: { level: 'HIGH' }, suspect: { value: false } } } }));
  const { client } = wrapped(isF1x), budget = new RunBudget(limitsFromBounds({ maxQueriesPerRun: 10 }));
  const evidence = await measureTieEvidence({ cfg, client: client as any, budget, proposals, cache: createProfileCache(), extendedProfile: true });
  assert.equal(evidence.queries, 4, 'two targets, each an F1x that timed out and the F1 that answered'); assert.equal(Object.keys(evidence.measured).length, 2);
  const dead = wrapped(() => true), none = await measureTieEvidence({ cfg, client: dead.client as any, budget: new RunBudget(limitsFromBounds({ maxQueriesPerRun: 10 })), proposals, cache: createProfileCache() });
  assert.deepEqual(none.notMeasured.map(item => item.reason), ['TIMEOUT', 'TIMEOUT']);
});
