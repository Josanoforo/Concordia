import test from 'node:test';
import assert from 'node:assert/strict';
import { validateExplorationCatalog } from '../src/agent/catalog.ts';
import { DeterministicChooser, type ActionChooser, type ChoiceCall } from '../src/agent/chooser.ts';
import { runAgent, prepareAgentContext } from '../src/agent/engine.ts';
import { compileReadSql, observedValues } from '../src/agent/exploration.ts';
import { selectProbes } from '../src/agent/probe-selector.ts';
import { budgetedClient, limitsFromBounds, RunBudget } from '../src/agent/run-budget.ts';
import { universeManifests, resolveUniverseManifest, validateUniverseConfig } from '../src/registry/universes.ts';
import { readJson } from '../src/runtime.ts';

const TABLES: Record<string, { columns: string[]; rows: string[][] }> = {
  orders: { columns: ['order_id', 'customer_id', 'region_code'], rows: [['o1', 'c1', 'r1'], ['o2', 'c2', 'r1'], ['o3', 'c1', 'r2']] },
  customers: { columns: ['customer_id', 'customer_name', 'segment_code'], rows: [['c1', 'Ana', 's1'], ['c2', 'Beto', 's2'], ['c9', 'Extra', 's3']] },
  regions: { columns: ['region_code', 'region_name'], rows: [['r1', 'North'], ['r2', 'South'], ['r7', 'Unused']] }
};
function fakeClient(log: string[] = []) {
  let n = 0;
  return {
    async describe(_db: string, table: string) { return { rows: TABLES[table].columns.map(column => [column, 'string']), requestId: `fake-describe-${table}` }; },
    async runSql(sql: string, limit = 20) {
      log.push(sql);
      const table = Object.keys(TABLES).find(name => new RegExp(`\\b${name}\\b`).test(sql))!;
      const select = /^SELECT (.+?) FROM /s.exec(sql)![1].split(',').map(item => item.trim().replace(/`/g, ''));
      const meta = TABLES[table];
      let rows = meta.rows;
      const include = /(\w+)`? IN \(([^)]*)\)/.exec(sql);
      if (include) { const col = meta.columns.indexOf(include[1].replace(/`/g, '')), values = [...include[2].matchAll(/'([^']*)'/g)].map(item => item[1]); rows = rows.filter(row => values.includes(row[col])); }
      const exclude = /(\w+)`? NOT IN \(([^)]*)\)/.exec(sql);
      if (exclude) { const col = meta.columns.indexOf(exclude[1].replace(/`/g, '')), values = [...exclude[2].matchAll(/'([^']*)'/g)].map(item => item[1]); rows = rows.filter(row => !values.includes(row[col])); }
      n++;
      return { sql, requestId: `fake-req-${n}`, queryId: `fake-q-${n}`, rows: rows.slice(0, limit).map(row => select.map(column => row[meta.columns.indexOf(column)])), durationMs: 0, utc: '2026-10-24T00:00:00.000Z' };
    }
  };
}
class ScriptedChooser implements ActionChooser {
  seen: { stage: string; allowed: readonly string[] }[] = [];
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _observation: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    this.seen.push({ stage, allowed });
    const selected = this.script.shift() ?? 'STOP_EXPLORATION';
    return { stage, status: 'PASS', decisionStatus: allowed.includes(selected) ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: allowed.includes(selected) ? selected : undefined,
      reason: 'scripted offline choice', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}

test('registry validates every AGENT_EXPLORATION universe catalog and rejects catalogs outside the allowlist', () => {
  const agentManifests = universeManifests.filter(manifest => manifest.capabilities.includes('AGENT_EXPLORATION'));
  assert.deepEqual(agentManifests.map(manifest => manifest.aliases[0]).sort(), ['AGENTFX', 'U2']);
  for (const manifest of agentManifests) assert.deepEqual(validateUniverseConfig(manifest, readJson(manifest.source.configPath!)), []);
  const cfg = readJson('universes/AGENT_fixture.json');
  const bad = (mutate: (copy: any) => void) => { const copy = structuredClone(cfg); mutate(copy); return validateExplorationCatalog(copy, 'x').map(issue => issue.code); };
  assert.ok(bad(copy => { copy.explorationCatalog.actions[0].table = 'secrets'; }).includes('ACTION_OUTSIDE_ALLOWLIST'));
  assert.ok(bad(copy => { copy.explorationCatalog.safeOptionalColumns.customers = ['home_address']; }).includes('INVALID_SAFE_OPTIONAL_COLUMNS'));
  assert.ok(bad(copy => { copy.explorationCatalog.actions[0].observation = 'nope'; }).includes('UNKNOWN_OBSERVATION'));
  assert.ok(bad(copy => { copy.explorationCatalog.actions.push({ ...copy.explorationCatalog.actions[0] }); }).includes('INVALID_OR_DUPLICATE_ACTION_ID'));
  assert.ok(bad(copy => { copy.explorationCatalog.actions[0].id = 'STOP_EXPLORATION'; }).includes('INVALID_OR_DUPLICATE_ACTION_ID'));
  assert.ok(bad(copy => { delete copy.explorationCatalog; }).includes('EXPLORATION_CATALOG_REQUIRED'));
  const manifest = structuredClone(resolveUniverseManifest('AGENTFX')!);
  delete (manifest.capabilityBounds as any).AGENT_EXPLORATION;
  assert.throws(() => limitsFromBounds({ readLimit: 5000 }), /RUN_BUDGET_INVALID/);
});

test('run budget defaults mirror the measured U2 run and the budgeted client refuses the query past the cap', async () => {
  assert.deepEqual(limitsFromBounds(), { maxQueriesPerRun: 25, readLimit: 50, maxTokensPerRun: 15000, maxSteps: 3 });
  const budget = new RunBudget(limitsFromBounds({ maxQueriesPerRun: 2 }));
  const client = budgetedClient(fakeClient(), budget);
  await client.runSql('SELECT customer_id FROM AGENT_FIXTURE.orders LIMIT 5', 5);
  await client.runSql('SELECT customer_id FROM AGENT_FIXTURE.orders LIMIT 5', 5);
  await assert.rejects(() => client.runSql('SELECT customer_id FROM AGENT_FIXTURE.orders LIMIT 5', 5), /AGENT_QUERY_BUDGET_EXCEEDED/);
  assert.equal(budget.snapshot().used.queries, 2);
  assert.deepEqual(budget.snapshot().exhausted, ['queries']);
});

test('probe selector spends the remaining budget in config order, or lets a chooser rank fixed PROBE options', async () => {
  const relations = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const tight = new RunBudget(limitsFromBounds({ maxQueriesPerRun: 5 }));
  const all = await selectProbes({ relations, budget: tight });
  assert.deepEqual(all.selected, ['a', 'b']);
  assert.deepEqual(all.skipped, [{ relationId: 'c', reason: 'QUERY_BUDGET_INSUFFICIENT' }]);
  const chooser = new ScriptedChooser(['PROBE:c', 'PROBE:injected; DROP', 'STOP_EXPLORATION']);
  const chosen = await selectProbes({ relations, budget: new RunBudget(limitsFromBounds()), chooser });
  assert.deepEqual(chosen.selected, ['c']);
  assert.equal(chosen.mode, 'CHOSEN');
  assert.deepEqual(chosen.skipped.map(item => item.relationId).sort(), ['a', 'b']);
  assert.ok(chooser.seen[0].allowed.every(item => item === 'STOP_EXPLORATION' || /^PROBE:[a-c]$/.test(item)));
});

test('catalog templates compile fixed SQL from observed rows only, with column and literal guards', () => {
  const cfg = readJson('universes/AGENT_fixture.json'), catalog = cfg.explorationCatalog;
  const discovery = { tables: { orders: { columns: ['customer_id', 'region_code'], sample: { rows: [['c1', 'r1'], ['c2', "r1'; DROP"], [null, 'r2']] } } } };
  const state = observedValues(catalog, discovery, {});
  assert.deepEqual(state.observedCustomers, ['c1', 'c2']);
  assert.deepEqual(state.observedRegions, ['r1', 'r2']);
  const described = new Set(['customer_id', 'customer_name', 'segment_code', 'home_address']);
  const compiled = compileReadSql(catalog.actions[0], cfg, catalog, described, state.observedCustomers, 50);
  assert.equal(compiled.sql, "SELECT `customer_id`, `customer_name`, `segment_code` FROM AGENT_FIXTURE.customers WHERE customer_id IN ('c1', 'c2') LIMIT 50");
  assert.throws(() => compileReadSql(catalog.actions[0], cfg, catalog, described, ["x'; DROP TABLE t; --"], 50), /AGENT_FILTER_VALUE_INVALID/);
  assert.throws(() => compileReadSql(catalog.actions[0], cfg, catalog, new Set(['customer_name']), ['c1'], 50), /AGENT_REQUIRED_COLUMN_UNAVAILABLE/);
  const u2 = readJson('universes/U2_companies.json');
  const sec = compileReadSql(u2.explorationCatalog.actions[0], u2, u2.explorationCatalog, new Set(['cik', 'sic', 'name', 'address']), ['320193', '0000320193'], 20);
  assert.equal(sec.sql, "SELECT `cik`, `sic`, `name` FROM SEC_DATA.apple_submissions_raw WHERE cik IN ('320193', '0000320193') LIMIT 20");
  const dns = compileReadSql(u2.explorationCatalog.actions[1], u2, u2.explorationCatalog, new Set(), ['3571'], 20);
  assert.match(dns.sql, /^SELECT sic_code, description FROM \(.+\) concordia_source WHERE sic_code IN \('3571'\) LIMIT 20$/s);
});

test('generic agent loop runs discovery, COMA, exploration, budgeted probes, critic and decisions on a non-U2 universe, offline', async () => {
  const log: string[] = [];
  const chooser = new ScriptedChooser(['READ_CUSTOMER_PROFILE', 'READ_REGION_REFERENCE']);
  const bridgeInputs: unknown[] = [];
  const report = await runAgent('AGENTFX', 'agent-agentfx-offline-1', { client: fakeClient(log) as any, chooser, executionMode: 'LOCAL', persist: false, now: () => '2026-10-24T00:00:00.000Z',
    comaBridge: input => {
      bridgeInputs.push(input);
      return { schemaVersion: 1, provider: 'valentine.Coma', version: '1.1.0', configuration: { max_n: 0, use_instances: false, use_schema: true, delta: 0.15, threshold: 0.0, instance_weight: 1.0 },
        matches: input.pairs.map(pair => ({ source: pair.source, target: pair.target, matches: [
          { sourceColumn: pair.allowed[0].sourceColumn, targetColumn: pair.allowed[0].targetColumn, rawScore: 0.9 },
          { sourceColumn: 'order_id', targetColumn: pair.allowed[0].targetColumn, rawScore: 0.4 }] })) };
    } });
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.executionMode, 'LOCAL');
  assert.equal(report.dataOrigin, 'SYNTHETIC');
  assert.deepEqual(report.phases.discovery.relations, ['orders_customer', 'orders_region', 'orders_order_trap']);
  assert.equal(report.phases.coma.status, 'RAN');
  assert.ok(report.phases.coma.outOfScopeProposals.length >= 2, 'out-of-scope COMA proposals are retained, never evaluated');
  assert.equal(JSON.stringify(bridgeInputs).includes('Ana'), false, 'COMA receives schema only');
  assert.deepEqual(report.phases.exploration.actions.map((item: any) => item.action), ['READ_CUSTOMER_PROFILE', 'READ_REGION_REFERENCE', 'STOP_EXPLORATION']);
  assert.ok(report.phases.exploration.actions.every((item: any) => ['PASS', 'NOT_REQUIRED'].includes(item.execution)));
  assert.deepEqual(report.phases.probes.selected, ['orders_customer', 'orders_region', 'orders_order_trap']);
  assert.equal(report.decisions.length, 3);
  assert.ok(report.decisions.every((item: any) => typeof item.verdict === 'string'));
  assert.equal(report.phases.critic.status, 'EVALUATED');
  assert.ok(report.budget.used.queries <= report.budget.limits.maxQueriesPerRun);
  assert.equal(report.budget.used.queries, log.length, 'every SQL statement is charged to the run budget');
  assert.ok(log.every(sql => /^SELECT /.test(sql) && !/DROP|DELETE|INSERT|UPDATE|;/i.test(sql)), 'read-only SELECT statements only');
});

test('generic agent loop stops exploration at the step cap, records an unavailable chooser, and refuses non-agent universes', async () => {
  const noChooser = await runAgent('AGENTFX', 'agent-agentfx-offline-2', { client: fakeClient() as any, executionMode: 'LOCAL', persist: false, critic: false });
  assert.equal(noChooser.phases.exploration.plannerError.code, 'AGENT_CHOOSER_UNAVAILABLE');
  assert.equal(noChooser.phases.critic.status, 'DISABLED');
  assert.ok(noChooser.phases.probes.selected.length > 0, 'probes still run without a chooser');
  const loopy = new ScriptedChooser(['READ_CUSTOMER_PROFILE', 'READ_REGION_REFERENCE', 'READ_CUSTOMER_PROFILE', 'READ_REGION_REFERENCE']);
  const capped = await runAgent('AGENTFX', 'agent-agentfx-offline-3', { client: fakeClient() as any, chooser: loopy, executionMode: 'LOCAL', persist: false, critic: false });
  assert.equal(capped.budget.used.steps <= 3, true);
  assert.throws(() => prepareAgentContext('U1', 'agent-u1-x', { client: fakeClient() as any }), /UNIVERSE_LACKS_AGENT_EXPLORATION/);
  assert.throws(() => prepareAgentContext('AGENTFX', 'not-an-agent-run', { client: fakeClient() as any }), /AGENT_RUN_ID_INVALID/);
  const deterministic = await runAgent('AGENTFX', 'agent-agentfx-offline-4', { client: fakeClient() as any, chooser: new DeterministicChooser(), executionMode: 'LOCAL', persist: false, critic: false });
  assert.equal(deterministic.phases.exploration.actions[0].action, 'READ_CUSTOMER_PROFILE');
});
