import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** N27: a failed exploration read is reported as EXPLORATION_READ_FAILED (n=count) and keeps the run DEGRADED even when a later budget stop overwrites plannerError. */
const NOW = '2026-10-24T00:00:00Z';
function setup(stopAfterFirst: boolean) {
  const fixture = structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!), inner = fixtureClient(universeConfig('AGENTFX'), fixture.tables) as any;
  let armed = false, thrown = false;
  const client = { ...inner, runSql: async (sql: string, limit?: number) => { if (armed && !thrown) { thrown = true; throw new Error('read exploded'); } return inner.runSql(sql, limit); } };
  const script = ['READ_CUSTOMER_PROFILE', 'READ_REGION_REFERENCE'];
  const chooser: ActionChooser = {
    estimateTokens: (stage: string) => (stopAfterFirst && stage.endsWith('_2') ? 1e9 : 0),
    async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
      armed = true;
      const next = script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
      return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: NOW };
    }
  } as ActionChooser;
  return runAgent('AGENTFX', 'agent-n27', { client: client as any, chooser, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false, now: () => NOW }) as Promise<any>;
}

test('a read FAIL followed by a budget stop still leaves COMPLETED_WITH_WARNINGS with EXPLORATION_READ_FAILED n=1 and the error list in phases.exploration', async () => {
  const report = await setup(true);
  assert.equal(report.phases.exploration.explorationErrors.length, 1);
  assert.ok(report.phases.exploration.plannerError?.code, 'the later stop overwrote plannerError (kept for compatibility)');
  const item = report.degradations.find((d: any) => d.code === 'EXPLORATION_READ_FAILED');
  assert.ok(item && /n=1/.test(item.detail ?? item.message ?? JSON.stringify(item)), JSON.stringify(report.degradations));
  assert.equal(report.status, 'COMPLETED_WITH_WARNINGS', 'exploration is an auxiliary phase: the core is complete');
  assert.match(report.statusExplanation, /exploración \(EXPLORATION_READ_FAILED\)/);
});

test('a clean exploration has an empty explorationErrors list and no EXPLORATION_READ_FAILED', async () => {
  const fixture = structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!);
  const report: any = await runAgent('AGENTFX', 'agent-n27-clean', { client: fixtureClient(universeConfig('AGENTFX'), fixture.tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false, now: () => NOW });
  assert.deepEqual(report.phases.exploration.explorationErrors, []);
  assert.ok(!report.degradations.some((d: any) => d.code === 'EXPLORATION_READ_FAILED'));
});
