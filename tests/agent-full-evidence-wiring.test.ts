import test from 'node:test';
import assert from 'node:assert/strict';
import { fullEvidenceOf, prepareAgentContext, probeQueryCostOf, runDiscoveryPhase, runProbeStage } from '../src/agent/engine.ts';
import { PROBE_QUERY_COST } from '../src/agent/probe-selector.ts';
import { FULL_EVIDENCE_MAX_QUERIES } from '../src/probe/full-evidence.ts';
import { budgetedClient, limitsFromBounds, RunBudget } from '../src/agent/run-budget.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** P3 wiring: a manifest that declares fullEvidence turns whole-table evidence on for the contract probes, and the probe selection reserves its aggregate queries. */
const cfg = universeConfig('AGENTFX');
async function stage(fullEvidence: boolean | undefined, extraQueries: number) {
  const make = (maxQueries: number) => {
    const raw = fixtureClient(cfg, structuredClone(agentFixtures().find(i => i.alias === 'AGENTFX')!).tables) as any;
    const ctx = prepareAgentContext('AGENTFX', 'agent-fe-wire', { client: raw, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false });
    const budget = new RunBudget(limitsFromBounds({ maxQueriesPerRun: maxQueries }));
    Object.assign(ctx, { budget, client: budgetedClient(raw, budget), manifest: { ...ctx.manifest, ...(fullEvidence === undefined ? {} : { fullEvidence }) } });
    return ctx;
  };
  // discovery reads are charged too: measure them first so `extraQueries` is what is left for the probes
  const dry = make(200), dryPhase = await runDiscoveryPhase(dry), spent = dry.budget.queries;
  void dryPhase;
  const ctx = make(spent + extraQueries), phase = await runDiscoveryPhase(ctx);
  return { ctx, result: await runProbeStage(ctx, phase) };
}

test('P3 wiring: only a manifest that declares fullEvidence: true turns it on, and the per-probe query cost includes the aggregate queries', () => {
  assert.equal(fullEvidenceOf({ manifest: { fullEvidence: true } }), true);
  for (const manifest of [{}, { fullEvidence: false }, { fullEvidence: 'yes' }, undefined]) assert.equal(fullEvidenceOf({ manifest }), false);
  assert.equal(probeQueryCostOf({ manifest: {} }), PROBE_QUERY_COST);
  assert.equal(probeQueryCostOf({ manifest: { fullEvidence: true } }), PROBE_QUERY_COST + FULL_EVIDENCE_MAX_QUERIES);
});

test('P3 wiring: with fullEvidence declared every probe carries a whole-table measurement; without it none does', async () => {
  const on = await stage(true, 60), off = await stage(undefined, 60);
  assert.ok(on.result.relations.length > 0 && on.result.relations.every((probe: any) => probe.evidence?.fullEvidence?.scope === 'GLOBAL_WHOLE_TABLE'));
  assert.ok(off.result.relations.length > 0 && off.result.relations.every((probe: any) => probe.evidence?.fullEvidence === undefined));
});

test('P3 wiring: the selection reserves the aggregate queries, so a tight budget probes fewer relations instead of running out inside a probe', async () => {
  const tightOff = await stage(undefined, 8), tightOn = await stage(true, 8);
  assert.equal(tightOff.result.selection.selected.length, 3, 'three probes at 2 queries fit in 8');
  assert.equal(tightOn.result.selection.selected.length, 1, 'at 7 queries each only one fits in 8');
  assert.equal(tightOn.result.selection.skipped.filter(item => item.reason === 'QUERY_BUDGET_INSUFFICIENT').length, 2);
});
