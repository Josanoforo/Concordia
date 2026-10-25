import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAgentLoop } from '../src/eval/agent-eval.ts';

test('agent loop offline evaluation reports exact denominators per universe and is reproducible (L3-E, synthetic, no gold, no live)', async () => {
  const first = await evaluateAgentLoop(), second = await evaluateAgentLoop();
  assert.equal(first.live, false); assert.equal(first.gold, 'NOT_USED'); assert.equal(first.dataOrigin, 'SYNTHETIC');
  assert.deepEqual(first.evaluation.metrics, second.evaluation.metrics, 'metrics are deterministic');
  assert.deepEqual(first.evaluation.results, second.evaluation.results);
  assert.equal(first.registry.manifests, 13);
  assert.equal(first.registry.agentCapable, 2);
  assert.equal(first.registry.evaluated, 2);
  assert.deepEqual(first.registry.skipped, []);
  assert.equal(first.registry.notEnrolled.length, 11, 'universes without AGENT_EXPLORATION are reported as not enrolled');
  const metric = (universe: string, method: string) => first.evaluation.metrics.find(item => item.universeId === universe && item.methodId === method)!;
  const fx = metric('concordia.universe.agent-fixture', 'agent-loop');
  assert.deepEqual(fx.denominator, { allCases: 3, consulted: 3, evaluated: 3, notConsulted: 0, accepts: 2, adjudicatedAccepts: 2, nonapprovable: 1, positives: 2 });
  assert.deepEqual(fx.counts, { correctAccept: 2, falseAccept: 0, unknownAdjudications: 0, rejects: 0, abstentions: 1, reviewed: 3, errors: 0, notConsulted: 0 });
  assert.equal(fx.precisionAccept, 1); assert.equal(fx.falseAcceptanceRate, 0); assert.equal(fx.recallPositive, 1);
  const u2 = metric('concordia.universe.sec-companies', 'agent-loop');
  assert.deepEqual(u2.denominator, { allCases: 3, consulted: 3, evaluated: 3, notConsulted: 0, accepts: 0, adjudicatedAccepts: 0, nonapprovable: 1, positives: 1 });
  assert.equal(u2.counts.abstentions, 3); assert.equal(u2.counts.unknownAdjudications, 1);
  assert.equal(u2.precisionAccept, null, 'no accepts: precision is undefined, not zero');
  for (const universe of ['concordia.universe.agent-fixture', 'concordia.universe.sec-companies']) {
    assert.deepEqual(metric(universe, 'probes-only').counts, metric(universe, 'agent-loop').counts, 'exploration never changes the deterministic verdicts');
  }
  assert.ok(first.runs.every(run => run.status === 'COMPLETED' && run.queries <= 25));
  assert.deepEqual(first.runs.filter(run => run.method === 'probes-only').map(run => run.steps), [0, 0]);
});
