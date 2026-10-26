import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogOf } from '../src/agent/catalog.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { PROBE_HINT_REASON_LIMIT, probeHintsFrom, runExploration, type ExplorationRecord } from '../src/agent/exploration.ts';
import { selectProbes } from '../src/agent/probe-selector.ts';
import { limitsFromBounds, RunBudget } from '../src/agent/run-budget.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { readJson } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

const cfg = universeConfig('AGENTFX'), catalog = catalogOf(cfg)!;
const read = (action: string, reason: string | undefined, execution: ExplorationRecord['execution'] = 'PASS'): ExplorationRecord => ({ step: 1, action, reason, execution, adaptedFromObservedState: true });
const relations = (ids: string[]) => ids.map(id => ({ id }));
const tight = (queries: number) => new RunBudget(limitsFromBounds({ maxQueriesPerRun: queries }));

class Ranker implements ActionChooser {
  seen: { allowed: readonly string[]; observation: any }[] = [];
  constructor(private readonly picks: string[], private readonly tokens = 50) {}
  async choose(stage: string, observation: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    this.seen.push({ allowed, observation });
    const next = this.picks.shift() ?? 'STOP_EXPLORATION';
    return { stage, status: 'PASS', decisionStatus: 'VALID', requestedModel: 'scripted', selected: next, reason: 'scripted ranking', promptHash: 'x', utc: '2026-10-25T00:00:00.000Z', receipt: { totalTokens: this.tokens } as any };
  }
}

test('P6: hints name the configured relations a chosen, executed read concerned, one per relation, reasons capped and clean', () => {
  const long = 'x'.repeat(400);
  const hints = probeHintsFrom([read('READ_CUSTOMER_PROFILE', `customer key\nlooks shared ${long}`), read('READ_REGION_REFERENCE', 'region codes line up')], catalog, cfg.relations);
  assert.deepEqual(hints.map(hint => [hint.relationId, hint.sourceAction]), [['orders_customer', 'READ_CUSTOMER_PROFILE'], ['orders_order_trap', 'READ_CUSTOMER_PROFILE'], ['orders_region', 'READ_REGION_REFERENCE']]);
  assert.ok(hints[0]!.reason.length <= PROBE_HINT_REASON_LIMIT && !/[\n\r]/.test(hints[0]!.reason));
  // The first read wins for a relation; failed reads, unchosen steps (no reason) and unknown actions give nothing.
  const again = probeHintsFrom([read('READ_CUSTOMER_PROFILE', 'first'), read('READ_CUSTOMER_PROFILE', 'second'), read('READ_REGION_REFERENCE', 'x', 'FAIL'), read('READ_ORDERS_BY_REGION', undefined), read('GHOST', 'nope')], catalog, cfg.relations);
  assert.deepEqual(again.map(hint => [hint.relationId, hint.reason]), [['orders_customer', 'first'], ['orders_order_trap', 'first']]);
});

test('P6: the exploration loop emits hints from the reads the model chose, and none when nothing was read', async () => {
  const gtfs: any = { tables: { trips: { db: 'GTFS', physicalTable: 'trips', columns: [{ name: 'trip_id' }, { name: 'route_id' }] }, routes: { db: 'GTFS', physicalTable: 'routes', columns: [{ name: 'route_id' }, { name: 'agency_id' }] } },
    relations: [{ id: 'trips_routes', from: { table: 'trips', column: 'route_id' }, to: { table: 'routes', column: 'route_id' } }, { id: 'unrelated', from: { table: 'trips', column: 'trip_id' }, to: { table: 'routes', column: 'agency_id' } }],
    explorationCatalog: { productLabel: 'GTFS', plannerTask: 'compare route keys', observations: { ROUTE_IDS: { fromTable: 'trips', column: 'route_id', pattern: '^[0-9]+$' } }, actions: [{ id: 'READ_ROUTES', kind: 'KEYED_READ', table: 'routes', filterColumn: 'route_id', observation: 'ROUTE_IDS' }] } };
  const discovery = { tables: { trips: { columns: ['trip_id', 'route_id'], sample: { queryId: 'q0', rows: [['t1', '7']] } }, routes: { columns: ['route_id', 'agency_id'], sample: { queryId: 'q1', rows: [] } } } };
  const sourceColumns = { routes: [{ name: 'route_id', type: 'string' }, { name: 'agency_id', type: 'string' }] };
  const run = (script: string[]) => runExploration({ runId: 'x', cfg: gtfs, catalog: gtfs.explorationCatalog, discovery, sourceColumns, budget: new RunBudget(limitsFromBounds({ maxSteps: 3 })), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC',
    client: { runSql: async () => ({ rows: [['7', 'A']], queryId: 'qid', requestId: 'r', utc: 'u' }) } as any,
    chooser: { choose: async () => ({ stage: 's', status: 'PASS', decisionStatus: 'VALID', selected: script.shift(), reason: 'route keys of trips look present in routes', requestedModel: 'scripted', promptHash: 'x', utc: 'u' }) } as any });
  const withRead = await run(['READ_ROUTES', 'STOP_EXPLORATION']);
  assert.deepEqual(withRead.hints, [{ relationId: 'trips_routes', sourceAction: 'READ_ROUTES', reason: 'route keys of trips look present in routes' }]);
  assert.equal((await run(['STOP_EXPLORATION'])).hints, undefined);
});

test('P6: hints change the ORDER in which probes get the budget, nothing else: only the hinted relation fits and it is the one probed', async () => {
  const noHints = await selectProbes({ relations: relations(['a', 'b', 'c']), budget: tight(2) });
  assert.deepEqual(noHints.selected, ['a']); assert.deepEqual(noHints.skipped.map(item => item.relationId), ['b', 'c']);
  const hinted = await selectProbes({ relations: relations(['a', 'b', 'c']), budget: tight(2), hints: [{ relationId: 'c', sourceAction: 'READ_X', reason: 'looks shared' }] });
  assert.deepEqual(hinted.selected, ['c']); assert.deepEqual(hinted.skipped.map(item => item.relationId).sort(), ['a', 'b']);
  assert.deepEqual(hinted.hints, { applied: ['c'], ignored: [], reordered: true });
  assert.equal(hinted.mode, 'ALL_AFFORDABLE');
});

test('P6: with room for every probe the same relations run with or without hints (no relation is added, dropped or decided)', async () => {
  const hints = [{ relationId: 'b', sourceAction: 'R', reason: 'x' }, { relationId: 'GHOST', sourceAction: 'R', reason: 'not configured' }, { relationId: 'b', sourceAction: 'R', reason: 'dup' }];
  const plain = await selectProbes({ relations: relations(['a', 'b', 'c']), budget: new RunBudget(limitsFromBounds()) });
  const withHints = await selectProbes({ relations: relations(['a', 'b', 'c']), budget: new RunBudget(limitsFromBounds()), hints });
  assert.deepEqual([...withHints.selected].sort(), [...plain.selected].sort());
  assert.deepEqual(withHints.selected, ['b', 'a', 'c'], 'hinted first, the rest in config order');
  assert.deepEqual(withHints.hints, { applied: ['b'], ignored: ['GHOST'], reordered: true });
  assert.deepEqual(plain.skipped, withHints.skipped);
  const unhinted = await selectProbes({ relations: relations(['a', 'b']), budget: new RunBudget(limitsFromBounds()), hints: [] });
  assert.deepEqual(unhinted.hints, { applied: [], ignored: [], reordered: false });
});

test('P6: with a ranking model the hints are shown to it and put first in the offered options; token accounting is the same as without hints', async () => {
  const withHints = new RunBudget(limitsFromBounds()), without = new RunBudget(limitsFromBounds());
  const rankerA = new Ranker(['PROBE:c', 'STOP_EXPLORATION']), rankerB = new Ranker(['PROBE:c', 'STOP_EXPLORATION']);
  const a = await selectProbes({ relations: relations(['a', 'b', 'c']), budget: withHints, chooser: rankerA, hints: [{ relationId: 'c', sourceAction: 'R', reason: 'the shared key' }, { relationId: 'GHOST', sourceAction: 'R', reason: 'x' }] });
  const b = await selectProbes({ relations: relations(['a', 'b', 'c']), budget: without, chooser: rankerB });
  assert.deepEqual(rankerA.seen[0]!.allowed, ['PROBE:c', 'PROBE:a', 'PROBE:b', 'STOP_EXPLORATION']);
  assert.deepEqual(rankerB.seen[0]!.allowed, ['PROBE:a', 'PROBE:b', 'PROBE:c', 'STOP_EXPLORATION']);
  assert.deepEqual(rankerA.seen[0]!.observation.explorationHints, [{ relationId: 'c', reason: 'the shared key' }]);
  assert.equal(rankerB.seen[0]!.observation.explorationHints, undefined);
  assert.deepEqual(a.selected, ['c']); assert.deepEqual(b.selected, ['c']);
  assert.equal(withHints.tokens, without.tokens, 'hints cost no tokens of their own'); assert.equal(withHints.tokens, 100);
  assert.equal(withHints.queries, without.queries);
});

test('P6: the model may ignore a hint: its own pick wins, and a hint never forces a probe', async () => {
  const ranker = new Ranker(['PROBE:a', 'STOP_EXPLORATION']);
  const out = await selectProbes({ relations: relations(['a', 'b', 'c']), budget: new RunBudget(limitsFromBounds()), chooser: ranker, hints: [{ relationId: 'c', sourceAction: 'R', reason: 'hint' }] });
  assert.deepEqual(out.selected, ['a']); assert.deepEqual(out.skipped.map(item => [item.relationId, item.reason]).sort(), [['b', 'NOT_SELECTED'], ['c', 'NOT_SELECTED']]);
});
