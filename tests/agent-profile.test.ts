import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExplorationCatalog, type ExplorationCatalog } from '../src/agent/catalog.ts';
import { allowedActionIds, compileReadSql, observedValues, runExploration, summarizeRead } from '../src/agent/exploration.ts';
import { limitsFromBounds, RunBudget } from '../src/agent/run-budget.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

const cfgFor = (actions: any[], tables: any = {}): any => ({
  tables: {
    routes: { db: 'GTFS', physicalTable: 'routes', columns: [{ name: 'route_id' }, { name: 'agency_id' }, { name: 'contact_email' }] },
    ...tables
  },
  explorationCatalog: { productLabel: 'GTFS', plannerTask: 'profile route keys', observations: { ROUTE_IDS: { fromTable: 'routes', column: 'route_id', pattern: '^[0-9]+$' } }, actions }
});
const profile = { id: 'PROFILE_ROUTES', kind: 'BOUNDED_PROFILE', table: 'routes', filterColumn: 'route_id' };
const codes = (actions: any[], tables?: any) => validateExplorationCatalog(cfgFor(actions, tables), 'u').map(issue => issue.code);

test('R5-5: BOUNDED_PROFILE validates without an observation and is fenced by the same allowlist', () => {
  assert.deepEqual(codes([profile]), []);
  assert.deepEqual(codes([{ ...profile, filterColumn: 'contact_email' }]), ['FORBIDDEN_OR_INVALID_COLUMN']);
  assert.deepEqual(codes([{ ...profile, filterColumn: 'nope' }]), ['ACTION_OUTSIDE_ALLOWLIST']);
  assert.deepEqual(codes([{ ...profile, table: 'missing' }]), ['ACTION_OUTSIDE_ALLOWLIST']);
  assert.deepEqual(codes([{ ...profile, requiredColumns: ['agency_id'] }]), ['FORBIDDEN_OR_INVALID_COLUMN']);
  assert.deepEqual(codes([{ ...profile, observation: 'ROUTE_IDS' }]), ['UNKNOWN_OBSERVATION'], 'a profile takes no observed values');
  assert.deepEqual(codes([{ ...profile, kind: 'RAW_SQL' }]), ['UNSUPPORTED_ACTION_KIND']);
});

test('R5-5: catalogs already enrolled keep validating without changes', () => {
  for (const id of ['U1', 'U2']) assert.deepEqual(validateExplorationCatalog(universeConfig(id), id), [], id);
});

test('R5-5: the executor compiles one fixed template: counts over the key column, bounded by LIMIT, no values leave the source', () => {
  const cfg = cfgFor([profile]), catalog = cfg.explorationCatalog as ExplorationCatalog;
  const compiled = compileReadSql(catalog.actions[0]!, cfg, catalog, new Set(['route_id']), [], 25);
  assert.equal(compiled.sql, 'SELECT COUNT(*) AS concordia_rows, COUNT(DISTINCT route_id) AS concordia_distinct, SUM(CASE WHEN route_id IS NULL THEN 1 ELSE 0 END) AS concordia_nulls FROM (SELECT `route_id` FROM GTFS.routes LIMIT 25) concordia_bounded');
  assert.deepEqual(compiled.columns, ['concordia_rows', 'concordia_distinct', 'concordia_nulls']);
  assert.ok(!/contact_email|agency_id/.test(compiled.sql));
  assert.throws(() => compileReadSql(catalog.actions[0]!, cfg, catalog, new Set(['agency_id']), [], 25), /AGENT_REQUIRED_COLUMN_UNAVAILABLE/);
  const derived = cfgFor([profile], { routes: { db: 'GTFS', physicalTable: 'routes', baseSql: 'SELECT route_id FROM GTFS.routes', columns: [{ name: 'route_id' }] } });
  assert.match(compileReadSql(derived.explorationCatalog.actions[0], derived, derived.explorationCatalog, new Set(), [], 10).sql, /FROM \(SELECT route_id FROM .+\) concordia_source LIMIT 10\) concordia_bounded$/);
});

test('R5-5: the summary is derived by the executor: rows, distinct, nulls and bounded', () => {
  const cols = ['concordia_rows', 'concordia_distinct', 'concordia_nulls'];
  assert.deepEqual(summarizeRead(profile as any, [], cols, [[10, 7, 2]], 50), { kind: 'BOUNDED_PROFILE', rows: 10, distinct: 7, nulls: 2, limit: 50, bounded: false });
  assert.deepEqual(summarizeRead(profile as any, [], cols, [['50', '30', null]], 50), { kind: 'BOUNDED_PROFILE', rows: 50, distinct: 30, nulls: 0, limit: 50, bounded: true });
  assert.deepEqual(summarizeRead(profile as any, [], cols, [], 50), { kind: 'BOUNDED_PROFILE', rows: 0, distinct: 0, nulls: 0, limit: 50, bounded: false });
});

test('R5-5: the model only picks the id; a profile is offered even with no observed values and runs end to end', async () => {
  const cfg = cfgFor([profile]), catalog = cfg.explorationCatalog as ExplorationCatalog;
  const discovery = { tables: { routes: { columns: ['route_id'], sample: { queryId: 'q0', rows: [] } } } };
  assert.deepEqual(observedValues(catalog, discovery, {}), { ROUTE_IDS: [] });
  assert.deepEqual(allowedActionIds(catalog, discovery, { ROUTE_IDS: [] }, new Set()), ['PROFILE_ROUTES', 'STOP_EXPLORATION']);
  const script = ['PROFILE_ROUTES', 'STOP_EXPLORATION'];
  const chooser: any = { choose: async () => ({ stage: 's', status: 'PASS', decisionStatus: 'VALID', selected: script.shift(), reason: 'r' }) };
  const sqls: string[] = [];
  const client: any = { runSql: async (sql: string) => { sqls.push(sql); return { rows: [[12, 9, 1]], queryId: 'qid-1', requestId: 'r', utc: 'u' }; } };
  const budget = new RunBudget(limitsFromBounds({ maxSteps: 3 }));
  const result = await runExploration({ runId: 'x', cfg, catalog, discovery, sourceColumns: { routes: [{ name: 'route_id', type: 'string' }] }, client, chooser, budget, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' });
  assert.deepEqual(result.actions.map(item => [item.action, item.execution]), [['PROFILE_ROUTES', 'PASS'], ['STOP_EXPLORATION', 'NOT_REQUIRED']]);
  const summary = (result.actions[0]!.observation as any).summary;
  assert.deepEqual({ k: summary.kind, rows: summary.rows, distinct: summary.distinct, nulls: summary.nulls, bounded: summary.bounded }, { k: 'BOUNDED_PROFILE', rows: 12, distinct: 9, nulls: 1, bounded: false });
  assert.equal(sqls.length, 1);
  assert.match(sqls[0]!, /^SELECT COUNT\(\*\) AS concordia_rows/);
});
