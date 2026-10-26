import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogOf } from '../src/agent/catalog.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { runExploration } from '../src/agent/exploration.ts';
import { limitsFromBounds, RunBudget } from '../src/agent/run-budget.ts';
import { liveSummaryFields } from '../src/agent/cli-run.ts';

const gtfs: any = { tables: { trips: { db: 'GTFS', physicalTable: 'trips', columns: [{ name: 'trip_id' }, { name: 'route_id' }] }, routes: { db: 'GTFS', physicalTable: 'routes', columns: [{ name: 'route_id' }, { name: 'agency_id' }] } },
  relations: [{ id: 'trips_routes', from: { table: 'trips', column: 'route_id' }, to: { table: 'routes', column: 'route_id' } }],
  explorationCatalog: { productLabel: 'GTFS', plannerTask: 't', observations: { ROUTE_IDS: { fromTable: 'trips', column: 'route_id', pattern: '^[0-9]+$' } }, actions: [
    { id: 'READ_ROUTES', kind: 'KEYED_READ', table: 'routes', filterColumn: 'route_id', observation: 'ROUTE_IDS' },
    { id: 'READ_ROUTES_B', kind: 'KEYED_READ', table: 'routes', filterColumn: 'agency_id', observation: 'ROUTE_IDS' }] } };
const discovery = { tables: { trips: { columns: ['trip_id', 'route_id'], sample: { queryId: 'q0', rows: [['t1', '7']] } }, routes: { columns: ['route_id', 'agency_id'], sample: { queryId: 'q1', rows: [] } } } };
const sourceColumns = { routes: [{ name: 'route_id', type: 'string' }, { name: 'agency_id', type: 'string' }] };
const scripted = (picks: string[]): ActionChooser => ({ choose: async (stage: string): Promise<ChoiceCall> => ({ stage, status: 'PASS', decisionStatus: 'VALID', selected: picks.shift() ?? 'STOP_EXPLORATION', reason: 'r', requestedModel: 'scripted', promptHash: 'x', utc: 'u' }) });
const run = (picks: string[], runSql: (sql: string) => Promise<any>) => runExploration({ runId: 'x', cfg: gtfs, catalog: catalogOf(gtfs) ?? gtfs.explorationCatalog, discovery, sourceColumns, budget: new RunBudget(limitsFromBounds({ maxSteps: 5 })),
  executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', client: { runSql } as any, chooser: scripted(picks) });

test('N27: a failed read keeps exploring and every failure is kept with step, action and code; plannerError still holds the last one', async () => {
  let calls = 0;
  const result = await run(['READ_ROUTES', 'READ_ROUTES_B', 'STOP_EXPLORATION'], async () => { calls++; if (calls === 1) throw Object.assign(new Error('boom'), { code: 'ZETARIS_QUERY_FAILED' }); return { rows: [['7', 'A']], queryId: 'q', requestId: 'r', utc: 'u' }; });
  assert.equal(result.explorationErrors?.length, 1);
  assert.deepEqual([result.explorationErrors![0]!.step, result.explorationErrors![0]!.action, typeof result.explorationErrors![0]!.code], [1, 'READ_ROUTES', 'string']);
  assert.ok(result.actions.some(a => a.action === 'READ_ROUTES_B' && a.execution === 'PASS'), 'exploration continued after the failure');
  assert.ok(result.plannerError, 'compat: plannerError is kept');
  const two = await run(['READ_ROUTES', 'READ_ROUTES_B', 'STOP_EXPLORATION'], async () => { throw new Error('down'); });
  assert.deepEqual(two.explorationErrors!.map(e => [e.step, e.action]), [[1, 'READ_ROUTES'], [2, 'READ_ROUTES_B']]);
  assert.equal((await run(['STOP_EXPLORATION'], async () => ({ rows: [], queryId: 'q', requestId: 'r', utc: 'u' }))).explorationErrors, undefined);
});

test('N27: the summary carries the errors and their count, and the legacy explorationError key stays', () => {
  const errors = [{ step: 1, action: 'READ_ROUTES', code: 'X' }, { step: 2, action: 'READ_B', code: 'Y' }];
  const fields = liveSummaryFields({ phases: { exploration: { plannerError: { code: 'Y' }, explorationErrors: errors } }, probeSelection: { calls: [], selected: [] } });
  assert.deepEqual(fields.explorationErrors, errors); assert.equal(fields.explorationReadFailures, 2); assert.deepEqual(fields.explorationError, { code: 'Y' });
  const none = liveSummaryFields({ probeSelection: { calls: [], selected: [] } });
  assert.deepEqual(none.explorationErrors, []); assert.equal(none.explorationReadFailures, 0);
});
