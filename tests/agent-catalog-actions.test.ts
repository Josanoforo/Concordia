import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExplorationCatalog, type ExplorationCatalog } from '../src/agent/catalog.ts';
import { compileReadSql, runExploration, summarizeRead } from '../src/agent/exploration.ts';
import { limitsFromBounds, RunBudget } from '../src/agent/run-budget.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

const cfgFor = (actions: any[]): any => ({
  tables: {
    trips: { db: 'GTFS', physicalTable: 'trips', columns: [{ name: 'trip_id' }, { name: 'route_id' }] },
    routes: { db: 'GTFS', physicalTable: 'routes', columns: [{ name: 'route_id' }, { name: 'agency_id' }, { name: 'contact_email' }] }
  },
  explorationCatalog: { productLabel: 'GTFS', plannerTask: 'compare route keys', observations: { ROUTE_IDS: { fromTable: 'trips', column: 'route_id', pattern: '^[0-9]+$' } }, actions }
});
const compare = { id: 'COMPARE_ROUTES', kind: 'COMPARE_KEYS', table: 'routes', filterColumn: 'route_id', observation: 'ROUTE_IDS' };
const count = { id: 'COUNT_ROUTES', kind: 'AGGREGATE_COUNT', table: 'routes', filterColumn: 'route_id', observation: 'ROUTE_IDS' };
const codes = (actions: any[]) => validateExplorationCatalog(cfgFor(actions), 'u').map(issue => issue.code);

test('R-12: COMPARE_KEYS and AGGREGATE_COUNT validate; any other kind stays UNSUPPORTED_ACTION_KIND', () => {
  assert.deepEqual(codes([compare, count]), []);
  assert.deepEqual(codes([{ ...compare, kind: 'RAW_SQL' }]), ['UNSUPPORTED_ACTION_KIND']);
  assert.deepEqual(codes([{ ...compare, kind: 'SUM_COLUMN' }]), ['UNSUPPORTED_ACTION_KIND']);
});

test('R-12: the new kinds are fenced by the same allowlist and project nothing sensitive', () => {
  assert.deepEqual(codes([{ ...compare, filterColumn: 'contact_email' }]), ['FORBIDDEN_OR_INVALID_COLUMN']);
  assert.deepEqual(codes([{ ...count, filterColumn: 'nope' }]), ['ACTION_OUTSIDE_ALLOWLIST']);
  assert.deepEqual(codes([{ ...count, table: 'missing' }]), ['ACTION_OUTSIDE_ALLOWLIST']);
  assert.deepEqual(codes([{ ...compare, observation: 'GHOST' }]), ['UNKNOWN_OBSERVATION']);
  assert.deepEqual(codes([{ ...compare, requiredColumns: ['agency_id'] }]), ['FORBIDDEN_OR_INVALID_COLUMN']);
});

test('R-12: catalogs already enrolled keep validating without changes', () => {
  for (const id of ['U1', 'U2']) assert.deepEqual(validateExplorationCatalog(universeConfig(id), id), [], id);
});

test('R-12: the executor compiles fixed templates: key only, bounded by LIMIT, values from observed rows', () => {
  const cfg = cfgFor([compare, count]), catalog = cfg.explorationCatalog as ExplorationCatalog, described = new Set(['route_id', 'agency_id']);
  const cmp = compileReadSql(catalog.actions[0]!, cfg, catalog, described, ['7', '9'], 25);
  assert.equal(cmp.sql, "SELECT DISTINCT `route_id` FROM GTFS.routes WHERE route_id IN ('7', '9') LIMIT 25");
  assert.deepEqual(cmp.columns, ['route_id']);
  const agg = compileReadSql(catalog.actions[1]!, cfg, catalog, described, ['7'], 25);
  assert.equal(agg.sql, "SELECT `route_id`, COUNT(*) AS concordia_count FROM GTFS.routes WHERE route_id IN ('7') GROUP BY `route_id` LIMIT 25");
  assert.deepEqual(agg.columns, ['route_id', 'concordia_count']);
  assert.ok(!/contact_email|agency_id|\*(?!\))/.test(cmp.sql + agg.sql.replace('COUNT(*)', '')));
  assert.throws(() => compileReadSql(catalog.actions[0]!, cfg, catalog, new Set(['agency_id']), ['7'], 25), /AGENT_REQUIRED_COLUMN_UNAVAILABLE/);
  assert.throws(() => compileReadSql(catalog.actions[0]!, cfg, catalog, described, ["7'; DROP TABLE x"], 25), /AGENT_FILTER_VALUE_INVALID/);
});

test('R-12: summaries are derived by the executor from the observed keys and the rows returned', () => {
  assert.deepEqual(summarizeRead(compare as any, ['7', '9'], ['route_id'], [['7']]), { kind: 'COMPARE_KEYS', observedKeys: 2, present: ['7'], missing: ['9'] });
  assert.deepEqual(summarizeRead(count as any, ['7', '9'], ['route_id', 'concordia_count'], [['7', 3]]),
    { kind: 'AGGREGATE_COUNT', counts: { '7': 3 }, keysWithRows: 1, keysWithoutRows: ['9'] });
  assert.equal(summarizeRead({ ...compare, kind: 'KEYED_READ' } as any, ['7'], ['route_id'], [['7']]), undefined);
});

test('R-12: a model that picks the new action ids drives them end to end; keyed records keep their old shape', async () => {
  const cfg = cfgFor([{ id: 'READ_ROUTES', kind: 'KEYED_READ', table: 'routes', filterColumn: 'route_id', observation: 'ROUTE_IDS' }, compare, count]);
  const catalog = cfg.explorationCatalog as ExplorationCatalog;
  const discovery = { tables: { trips: { columns: ['trip_id', 'route_id'], sample: { queryId: 'q0', rows: [['t1', '7'], ['t2', '9']] } }, routes: { columns: ['route_id', 'agency_id'], sample: { queryId: 'q1', rows: [] } } } };
  const sourceColumns = { routes: [{ name: 'route_id', type: 'string' }, { name: 'agency_id', type: 'string' }] };
  const script = ['READ_ROUTES', 'COMPARE_ROUTES', 'COUNT_ROUTES', 'STOP_EXPLORATION'];
  const seen: string[] = [];
  const chooser: any = { choose: async (_stage: string, _obs: unknown, allowed: string[]) => { seen.push(allowed.join(',')); return { stage: 's', status: 'PASS', decisionStatus: 'VALID', selected: script.shift(), reason: 'r' }; } };
  const sqls: string[] = [];
  const client: any = { runSql: async (sql: string) => { sqls.push(sql);
    const rows = sql.includes('COUNT(*)') ? [['7', 2]] : sql.includes('DISTINCT') ? [['7']] : [['7', 'A']];
    return { rows, queryId: `qid-${sqls.length}`, requestId: 'r', utc: 'u' }; } };
  const budget = new RunBudget(limitsFromBounds({ maxSteps: 4 }));
  const result = await runExploration({ runId: 'x', cfg, catalog, discovery, sourceColumns, client, chooser, budget, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' });
  assert.deepEqual(result.actions.map(item => [item.action, item.execution]), [['READ_ROUTES', 'PASS'], ['COMPARE_ROUTES', 'PASS'], ['COUNT_ROUTES', 'PASS'], ['STOP_EXPLORATION', 'NOT_REQUIRED']]);
  assert.equal((result.actions[0]!.observation as any).summary, undefined);
  assert.deepEqual((result.actions[1]!.observation as any).summary, { kind: 'COMPARE_KEYS', observedKeys: 2, present: ['7'], missing: ['9'] });
  assert.deepEqual((result.actions[2]!.observation as any).summary.counts, { '7': 2 });
  assert.equal(sqls.length, 3);
  assert.ok(seen[0]!.includes('COMPARE_ROUTES') && seen[0]!.includes('COUNT_ROUTES'));
});
