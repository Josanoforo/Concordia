import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFixtures, agentLoopCriteria, evaluateAgentLoop, notEvaluatedCases, selectiveMetrics } from '../src/eval/agent-eval.ts';
import { resolveUniverseManifest, universeManifests } from '../src/registry/universes.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

test('agent loop offline evaluation reports exact denominators per universe and is reproducible (L3-E, synthetic, no gold, no live)', async () => {
  const first = await evaluateAgentLoop(), second = await evaluateAgentLoop();
  assert.equal(first.live, false); assert.equal(first.gold, 'NOT_USED'); assert.equal(first.dataOrigin, 'SYNTHETIC');
  assert.deepEqual(first.evaluation.metrics, second.evaluation.metrics, 'metrics are deterministic');
  assert.deepEqual(first.evaluation.results, second.evaluation.results);
  // Derived from the registry and the fixture directory, so enrolling a universe never breaks this test (F-06).
  const capable = universeManifests.filter(manifest => manifest.capabilities.includes('AGENT_EXPLORATION'));
  assert.equal(first.registry.manifests, universeManifests.length);
  assert.equal(first.registry.agentCapable, capable.length);
  assert.equal(first.registry.evaluated, agentFixtures().length);
  assert.deepEqual(first.registry.skipped, [], 'every agent-capable universe has an offline fixture');
  assert.equal(first.registry.evaluated, first.registry.agentCapable);
  assert.equal(first.registry.notEnrolled.length, universeManifests.length - capable.length, 'universes without AGENT_EXPLORATION are reported as not enrolled');
  const metric = (universe: string, method: string) => first.evaluation.metrics.find(item => item.universeId === universe && item.methodId === method)!;
  const fx = metric('concordia.universe.agent-fixture', 'agent-loop');
  assert.deepEqual(fx.denominator, { allCases: 3, consulted: 3, evaluated: 3, notConsulted: 0, accepts: 2, adjudicatedAccepts: 2, nonapprovable: 1, positives: 2 });
  assert.deepEqual(fx.counts, { correctAccept: 2, falseAccept: 0, unknownAdjudications: 0, rejects: 0, abstentions: 1, reviewed: 3, errors: 0, notConsulted: 0 });
  assert.equal(fx.precisionAccept, 1); assert.equal(fx.falseAcceptanceRate, 0); assert.equal(fx.recallPositive, 1);
  const u2 = metric('concordia.universe.sec-companies', 'agent-loop');
  assert.deepEqual(u2.denominator, { allCases: 3, consulted: 3, evaluated: 3, notConsulted: 0, accepts: 0, adjudicatedAccepts: 0, nonapprovable: 1, positives: 1 });
  assert.equal(u2.counts.abstentions, 3); assert.equal(u2.counts.unknownAdjudications, 1);
  assert.equal(u2.precisionAccept, null, 'no accepts: precision is undefined, not zero');
  const ny = metric('concordia.universe.ny-taxi', 'agent-loop');
  assert.deepEqual(ny.denominator, { allCases: 6, consulted: 6, evaluated: 6, notConsulted: 0, accepts: 4, adjudicatedAccepts: 0, nonapprovable: 1, positives: 0 });
  // F-04: the 4 human-reviewed U1 relations now reach SOSTENIDA on the untruncated synthetic fixture; the fixture leaves them unadjudicated on purpose, so none counts as correct.
  assert.equal(ny.counts.correctAccept, 0); assert.equal(ny.counts.falseAccept, 0); assert.equal(ny.counts.abstentions, 2); assert.equal(ny.counts.unknownAdjudications, 5); assert.equal(ny.precisionAccept, 0);
  for (const universe of ['concordia.universe.agent-fixture', 'concordia.universe.sec-companies', 'concordia.universe.ny-taxi']) {
    assert.deepEqual(metric(universe, 'probes-only').counts, metric(universe, 'agent-loop').counts, 'exploration never changes the deterministic verdicts');
  }
  assert.ok(first.runs.every(run => run.status === 'COMPLETED' && run.queries <= (resolveUniverseManifest(run.alias)!.capabilityBounds!.AGENT_EXPLORATION!.maxQueriesPerRun as number)), 'every run stays inside its own universe query bound');
  assert.deepEqual(first.runs.filter(run => run.method === 'probes-only').map(run => run.steps), agentFixtures().map(() => 0));
});

test('M4-4 selective prediction: coverage, abstention rate and risk per universe and method, with denominators and a null risk when nothing is adjudicated', async () => {
  const run = await evaluateAgentLoop(), pick = (universe: string, method: string) => run.selective.find(item => item.universeId === universe && item.methodId === method)!;
  assert.equal(run.selective.length, run.evaluation.metrics.length);
  const fx = pick('concordia.universe.agent-fixture', 'agent-loop');
  assert.deepEqual([fx.allCases, fx.decided, fx.coverage, fx.abstentions, fx.abstentionRate, fx.adjudicatedAccepts, fx.falseAccept, fx.risk, fx.riskReason, fx.unadjudicatedAccepts], [3, 2, 2 / 3, 1, 1 / 3, 2, 0, 0, null, 0], 'AGENTFX risk is 0 of 2 adjudicated accepts');
  const ny = pick('concordia.universe.ny-taxi', 'agent-loop');
  assert.deepEqual([ny.allCases, ny.decided, ny.coverage, ny.abstentions, ny.abstentionRate, ny.adjudicatedAccepts, ny.risk, ny.riskReason, ny.unadjudicatedAccepts], [6, 4, 4 / 6, 2, 2 / 6, 0, null, 'NO_ADJUDICATED_ACCEPTS', 4], 'U1: 4 accepts without adjudication, so risk is undefined, not zero');
  const u2 = pick('concordia.universe.sec-companies', 'agent-loop');
  assert.deepEqual([u2.decided, u2.coverage, u2.risk, u2.unadjudicatedAccepts], [0, 0, null, 0]);
  for (const item of run.selective) assert.ok(item.coverage === null || (item.coverage >= 0 && item.coverage <= 1));
  assert.deepEqual(selectiveMetrics({ universeId: 'x', methodId: 'm', denominator: { allCases: 0, accepts: 0, adjudicatedAccepts: 0 }, counts: { falseAccept: 0, rejects: 0, abstentions: 0 } }).coverage, null);
  assert.equal(selectiveMetrics({ universeId: 'x', methodId: 'm', denominator: { allCases: 4, accepts: 3, adjudicatedAccepts: 2 }, counts: { falseAccept: 1, rejects: 1, abstentions: 0 } }).risk, 0.5);
});

test('S5 minimum PASS criteria for the agent-loop method: a loop that takes no step, performs no action or probes nothing fails, per universe', async () => {
  const run = await evaluateAgentLoop();
  assert.equal(run.criteria.passed, true, JSON.stringify(run.criteria.failures));
  assert.equal(run.criteria.byUniverse.TPCDS.reason, 'BLIND_POST_COMA_EXECUTED_WITH_STANDIN', 'the blind universe passes because its post-COMA probes ran, and the report says the COMA was a stand-in');
  assert.deepEqual([run.comaStandIn.id, run.comaStandIn.universes], ['fixture.coma-standin', ['NWCH', 'TPCDS', 'U3']]); assert.ok(run.limitations.some(item => /stand-in fixture\.coma-standin, not COMA/.test(item)));
  assert.equal(run.runs.find(item => item.alias === 'TPCDS' && item.method === 'agent-loop')!.comaProvider, 'fixture.coma-standin'); assert.equal(run.runs.find(item => item.alias === 'U1' && item.method === 'agent-loop')!.comaProvider, null);
  assert.equal(run.criteria.byUniverse.U1.reason, 'PROBES_RAN');
  const base = { method: 'agent-loop', alias: 'X', status: 'COMPLETED', queries: 5, steps: 2, probes: 1, actionsPass: 1, configuredRelations: 1, comaStatus: 'NOT_CONFIGURED', postComaExecuted: 0 };
  const check = (patch: object, extra: { skipped?: any[]; fixtures?: string[] } = {}) => agentLoopCriteria({ runs: [{ ...base, ...patch }], skipped: extra.skipped ?? [], agentCapable: ['X'], fixtures: extra.fixtures ?? ['X'] });
  assert.equal(check({}).passed, true);
  assert.deepEqual(check({ steps: 0 }).byUniverse.X.failures, ['STEPS_ZERO']);
  assert.deepEqual(check({ actionsPass: 0 }).byUniverse.X.failures, ['NO_EXPLORATION_ACTION_PASSED']);
  assert.deepEqual(check({ probes: 0 }).byUniverse.X.failures, ['PROBES_ZERO_WITH_CONFIGURED_RELATIONS']);
  assert.deepEqual(check({ status: 'DEGRADED_NO_MODEL' }).byUniverse.X.failures, ['STATUS_NOT_COMPLETED:DEGRADED_NO_MODEL'], 'a degraded run is a failure offline');
  const blind = { configuredRelations: 0, probes: 0 };
  assert.equal(check({ ...blind, postComaExecuted: 4, comaStatus: 'RAN' }).byUniverse.X.reason, 'BLIND_POST_COMA_EXECUTED');
  assert.equal(check({ ...blind }).byUniverse.X.reason, 'BLIND_COMA_EXPLICITLY_NOT_CONFIGURED');
  assert.deepEqual(check({ ...blind, comaStatus: 'RAN' }).byUniverse.X.failures, ['BLIND_UNIVERSE_WITHOUT_POST_COMA_OR_EXPLICIT_COMA_STATE'], 'COMA ran but nothing was probed');
  assert.deepEqual(check({}, { skipped: [{ alias: 'X', reason: 'NO_OFFLINE_FIXTURE' }] }).failures.map(item => item.criterion), ['FIXTURE_REQUIRED']);
  assert.deepEqual(check({}, { fixtures: [] }).failures.map(item => item.criterion), ['FIXTURE_REQUIRED']);
  assert.deepEqual(agentLoopCriteria({ runs: [], skipped: [], agentCapable: ['X'], fixtures: ['X'] }).failures.map(item => item.criterion), ['AGENT_LOOP_RUN_REQUIRED']);
  assert.equal(check({ method: 'probes-only', steps: 0 }).passed, false, 'only the agent-loop method counts, and its run is missing here');
});

test('G1 a configured relation without typed evidence stays in the denominator as a not-evaluated case instead of being dropped', async () => {
  const fixture = agentFixtures().find(item => item.alias === 'U1')!, cfg = universeConfig('U1');
  const absent = notEvaluatedCases(fixture, cfg, new Set([`U1:${cfg.relations[0].id}`]), 'hash');
  assert.equal(absent.length, cfg.relations.length - 1);
  assert.ok(absent.every(item => item.evidence.length === 0 && item.caseId.startsWith('U1:') && item.split === 'DEVELOPMENT'));
  assert.deepEqual(notEvaluatedCases(fixture, cfg, new Set(cfg.relations.map((relation: any) => `U1:${relation.id}`)), 'hash'), [], 'nothing is added when every relation has its case');
  const run = await evaluateAgentLoop(), u1 = run.evaluation.metrics.find(item => item.universeId === 'concordia.universe.ny-taxi' && item.methodId === 'agent-loop')!;
  assert.equal(u1.denominator.allCases, cfg.relations.length, 'the denominator is the configured relation count');
});

test('RC-24 a probe without typed evidence stays in the denominator as a case with no evidence: allCases unchanged, the verdict falls to abstention', async () => {
  const base = await evaluateAgentLoop(), dropped = await evaluateAgentLoop({ withoutEvidence: (alias, relationId) => alias === 'U1' && relationId === 'trips_pickup_zones' });
  const metric = (run: typeof base) => run.evaluation.metrics.find(item => item.universeId === 'concordia.universe.ny-taxi' && item.methodId === 'agent-loop')!;
  assert.equal(metric(base).denominator.allCases, 6); assert.equal(metric(dropped).denominator.allCases, 6, 'the dropped case is not excluded from the total');
  assert.equal(metric(dropped).denominator.accepts, metric(base).denominator.accepts - 1, 'it can no longer be an accept');
  assert.equal(metric(dropped).counts.abstentions, metric(base).counts.abstentions + 1, 'it is counted as an abstention');
  assert.equal(dropped.selective.find(item => item.universeId === 'concordia.universe.ny-taxi' && item.methodId === 'agent-loop')!.allCases, 6);
});
