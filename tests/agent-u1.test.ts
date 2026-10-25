import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FORBIDDEN_COLUMN, validateExplorationCatalog } from '../src/agent/catalog.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { runAgent } from '../src/agent/engine.ts';
import { evaluateAgentLoop } from '../src/eval/agent-eval.ts';
import { fixtureClient, type AgentFixture } from '../src/eval/fixture-client.ts';
import { resolveUniverseManifest, validateUniverseConfig } from '../src/registry/universes.ts';
import { readJson, ROOT } from '../src/runtime.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

class ScriptChooser implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _observation: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', selected = allowed.includes(next) ? next : undefined;
    return { stage, status: 'PASS', decisionStatus: selected ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'fixture-script', selected, reason: 'fixture script choice', promptHash: 'fixture', utc: '2026-10-24T00:00:00.000Z' };
  }
}

const fixture = readJson<AgentFixture>('eval/agent/U1.json');
const EXPECTED_RELATIONS = ['yellow_pu_taxi_zones', 'yellow_do_taxi_zones', 'green_pu_taxi_zones', 'hvv_pu_taxi_zones', 'trips_pickup_zones', 'taxi_zones_zones_trap'];

test('U1 is enrolled in the generic agent loop with a valid catalog, relations and bounds', () => {
  const manifest = resolveUniverseManifest('U1')!, cfg = universeConfig('U1');
  assert.ok(manifest.capabilities.includes('AGENT_EXPLORATION'));
  assert.deepEqual(manifest.capabilityBounds?.AGENT_EXPLORATION, { maxQueriesPerRun: 50, readLimit: 20, maxTokensPerRun: 15000, maxSteps: 3 });
  assert.deepEqual(manifest.relationIds, EXPECTED_RELATIONS);
  assert.deepEqual(cfg.relations.map((relation: any) => relation.id), EXPECTED_RELATIONS);
  assert.deepEqual(validateUniverseConfig(manifest, cfg), []);
  assert.deepEqual(validateExplorationCatalog(cfg, 'U1'), []);
  assert.deepEqual(cfg.explorationCatalog.actions.map((action: any) => [action.id, action.kind]), [['READ_TAXI_ZONE_LOOKUP', 'KEYED_READ'], ['READ_ZONES_REFERENCE', 'KEYED_READ']]);
  for (const table of cfg.explorationCatalog.actions.map((action: any) => action.table)) assert.ok(cfg.tables[table].columns.every((column: any) => !FORBIDDEN_COLUMN.test(column.name)), `${table} exposes no sensitive column`);
  for (const excluded of cfg.excludedTables) assert.equal(cfg.tables[excluded], undefined, `${excluded} stays outside the allowlist`);
});

test('the full offline agent loop runs on U1 with its fixture: read-only, budgeted, deterministic verdicts', async () => {
  const log: string[] = [], cfg = universeConfig('U1');
  const run = () => runAgent('U1', 'agent-u1-offline-test', { client: fixtureClient(cfg, fixture.tables, log) as any, chooser: new ScriptChooser([...fixture.chooserScript]),
    executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: true, now: () => '2026-10-24T00:00:00Z' });
  const report: any = await run();
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.dataOrigin, 'SYNTHETIC');
  assert.equal(report.phases.discovery.tables.length, 10);
  assert.deepEqual(report.phases.discovery.relations, EXPECTED_RELATIONS);
  assert.deepEqual(report.phases.exploration.actions.map((item: any) => item.action), ['READ_TAXI_ZONE_LOOKUP', 'READ_ZONES_REFERENCE', 'STOP_EXPLORATION']);
  assert.ok(report.phases.exploration.actions.every((item: any) => ['PASS', 'NOT_REQUIRED'].includes(item.execution)));
  assert.equal(report.probeSelection.mode, 'ALL_AFFORDABLE');
  assert.deepEqual(report.phases.probes.selected, EXPECTED_RELATIONS, 'every configured relation is affordable inside the U1 bound');
  assert.deepEqual(report.phases.probes.skipped, []);
  assert.deepEqual(report.decisions.map((item: any) => item.relationId), EXPECTED_RELATIONS);
  const reviewed = ['yellow_pu_taxi_zones', 'yellow_do_taxi_zones', 'hvv_pu_taxi_zones', 'trips_pickup_zones'];
  for (const item of report.decisions) if (!reviewed.includes(item.relationId)) assert.notEqual(item.verdict, 'SOSTENIDA', `${item.relationId} is not human-reviewed, so it never reaches SOSTENIDA`);
  // F-04: reviewed relations may reach SOSTENIDA, but only on untruncated evidence (the live run stays INDETERMINADA, see u1-review-governance.test.ts).
  assert.ok(report.decisions.filter((item: any) => item.verdict === 'SOSTENIDA').every((item: any) => reviewed.includes(item.relationId)));
  assert.equal(report.phases.critic.status, 'EVALUATED');
  assert.ok(report.budget.used.queries <= report.budget.limits.maxQueriesPerRun);
  assert.equal(report.budget.used.queries, log.length, 'every SQL statement is charged to the run budget');
  assert.ok(!report.budget.exhausted.includes('queries'), 'the 50-query bound covers discovery, reads, probes and critic');
  assert.ok(log.every(sql => /^SELECT /.test(sql) && !/\b(DROP|DELETE|INSERT|UPDATE|CREATE|ALTER)\b|;/i.test(sql)), 'read-only SELECT statements only');
  assert.ok(log.every(sql => !/\b(drivers|customers|vehicles|driver_shifts|trip_payments)\b/.test(sql)), 'excluded tables are never queried');
  assert.deepEqual((await run()).decisions, report.decisions, 'deterministic across runs');
});

test('eval-agent counts U1 among the enrolled universes and evaluates its fixture', async () => {
  const evaluation = await evaluateAgentLoop();
  assert.ok(fs.existsSync(path.join(ROOT, 'eval/agent/U1.json')));
  const enrolled = evaluation.registry.agentCapable, notEnrolled = evaluation.registry.notEnrolled;
  assert.ok(enrolled >= 3 && !notEnrolled.includes('U1'), 'U1 is enrolled, not reported as not enrolled');
  assert.equal(evaluation.registry.skipped.some(item => item.alias === 'U1'), false, 'U1 has its offline fixture');
  assert.ok(evaluation.runs.some(run => run.alias === 'U1' && run.method === 'agent-loop' && run.status === 'COMPLETED'));
  const metric = (method: string) => evaluation.evaluation.metrics.find(item => item.universeId === 'concordia.universe.ny-taxi' && item.methodId === method)!;
  assert.equal(metric('agent-loop').denominator.allCases, 6);
  assert.equal(metric('agent-loop').denominator.nonapprovable, 1);
  assert.equal(metric('agent-loop').counts.falseAccept, 0);
  assert.deepEqual(metric('probes-only').counts, metric('agent-loop').counts, 'exploration never changes the deterministic verdicts');
});
