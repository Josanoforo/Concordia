import test from 'node:test';
import assert from 'node:assert/strict';
import { readJson } from '../src/runtime.ts';
import { canonicalJson2SchemaSha256, canonicalJson2TypedMultisetSha256, type Json2LiveBindingDocument } from '../src/relations/adapters/zetaris-json2.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { guardJson2Client } from '../src/agent/json2-guard.ts';
import { runAgent } from '../src/agent/engine.ts';
import { RunBudget, budgetedClient, limitsFromBounds } from '../src/agent/run-budget.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** Counts every statement that reaches the (fake) source, the offline equivalent of the zetaris events of a live trace. */
const counting = (inner: any) => { const seen = { n: 0 }; return { seen, client: { describe: (...a: any[]) => { seen.n++; return inner.describe(...a); }, runSql: (...a: any[]) => { seen.n++; return inner.runSql(...a); } } as any }; };
const fixtureOf = (alias: string) => agentFixtures().find(item => item.alias === alias)!;

test('M4-3 AGENTFX: used.totalSourceQueries equals the statements that reached the source (describe + select all counted)', async () => {
  const fx = fixtureOf('AGENTFX'), source = counting(fixtureClient(universeConfig('AGENTFX'), fx.tables));
  const report: any = await runAgent('AGENTFX', 'agent-budget-total-1', { client: source.client, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false });
  const used = report.budget.used;
  assert.ok(used.discoveryQueries > 0, 'discovery DESCRIBEs are visible');
  assert.equal(used.preflightQueries, 0);
  assert.equal(used.totalSourceQueries, used.queries + used.preflightQueries + used.discoveryQueries);
  assert.equal(used.totalSourceQueries, source.seen.n);
});

test('M4-3 GTFSAGENT with a simulated guard: preflight + discovery + gated reads add up to the source statements', async () => {
  const cfg = universeConfig('GTFSAGENT'), fx = fixtureOf('GTFSAGENT');
  const binding = readJson<Json2LiveBindingDocument>('universes/svp1-live-bindings.json');
  const bound = binding.tables.filter(item => ['gtfs_trips', 'gtfs_routes'].includes(item.physicalTable)).map(item => {
    const rows = fx.tables[item.physicalTable === 'gtfs_trips' ? 'trips' : 'routes'].rows;
    return { ...item, expectedRows: rows.length, observedSchemaSha256: canonicalJson2SchemaSha256(item.columns.map(c => [c.name, c.kind])), typedMultisetSha256: canonicalJson2TypedMultisetSha256(rows, item.columns) };
  });
  const source = counting(fixtureClient(cfg, fx.tables)), guarded = guardJson2Client(cfg, source.client, { ...binding, tables: bound } as Json2LiveBindingDocument);
  const report: any = await runAgent('GTFSAGENT', 'agent-budget-total-2', { client: guarded as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false });
  const used = report.budget.used;
  assert.ok(used.preflightQueries >= 1, 'the guard preflight is counted');
  assert.ok(used.discoveryQueries >= 1);
  assert.equal(used.totalSourceQueries, source.seen.n);
  assert.ok(used.queries < used.totalSourceQueries, 'the gated counter alone under-counted, which is what the live runs showed');
});

test('M4-3: describe is counted apart and does not consume the query cap', async () => {
  const budget = new RunBudget(limitsFromBounds({ maxQueriesPerRun: 1 })), calls: string[] = [];
  const client = budgetedClient({ describe: async () => { calls.push('d'); return { rows: [] }; }, runSql: async () => { calls.push('s'); return { rows: [] }; } } as any, budget) as any;
  await client.describe('db', 't'); await client.describe('db', 'u'); await client.runSql('SELECT 1', 1);
  assert.deepEqual([budget.queries, budget.discoveryQueries, budget.totalSourceQueries()], [1, 2, 3]);
  await assert.rejects(() => client.runSql('SELECT 2', 1), /AGENT_QUERY_BUDGET_EXCEEDED/);
});
