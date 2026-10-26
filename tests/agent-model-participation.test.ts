import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

class Elector implements ActionChooser {
  constructor(private readonly script: string[], private readonly estimate?: number) {}
  private step = 0;
  estimateTokens() { return this.estimate ?? 10; }
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const selected = this.script[Math.min(this.step++, this.script.length - 1)]!;
    return { stage, status: 'PASS', decisionStatus: allowed.includes(selected) ? 'VALID' : 'INVALID', requestedModel: 'scripted', selected, reason: 'scripted', promptHash: 'h', utc: '2026-10-26T00:00:00.000Z', receipt: { totalTokens: 10 } as any };
  }
}
const run = (alias: string, extra: Record<string, unknown> = {}) => {
  const cfg = universeConfig(alias), fixture = structuredClone(agentFixtures().find(i => i.alias === alias)!);
  return runAgent(alias, `agent-mp-${alias.toLowerCase()}`, { client: fixtureClient(cfg, fixture.tables) as any, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false, ...extra }) as Promise<any>;
};
const codes = (report: any) => report.degradations.map((d: any) => `${d.phase}:${d.code}`);

test('S1 USED: a requested model that made calls is USED and the run stays COMPLETED', async () => {
  const report = await run('AGENTFX', { modelRequested: true, chooser: new Elector(['READ_CUSTOMER_PROFILE', 'STOP_EXPLORATION']) });
  assert.equal(report.modelParticipation, 'USED'); assert.equal(report.modelParticipationReason, undefined);
  assert.equal(report.status, 'COMPLETED');
  assert.equal(codes(report).some((c: string) => c.startsWith('exploration:')), false);
});

test('S1 FAILED by the token guard: model requested, 0 calls, TOKEN_BUDGET_WOULD_EXCEED is DEGRADED_NO_MODEL, never COMPLETED', async () => {
  const report = await run('AGENTFX', { modelRequested: true, chooser: new Elector(['STOP_EXPLORATION'], 10_000_000) });
  assert.equal(report.phases.exploration.calls.length, 0);
  assert.equal(report.phases.exploration.plannerError.code, 'TOKEN_BUDGET_WOULD_EXCEED');
  assert.deepEqual([report.modelParticipation, report.modelParticipationReason, report.status], ['FAILED', 'TOKEN_BUDGET_WOULD_EXCEED', 'DEGRADED_NO_MODEL']);
  assert.ok(codes(report).includes('exploration:TOKEN_BUDGET_WOULD_EXCEED'));
});

test('S1 FAILED by the chooser: a construction error becomes the planner error and the reason', async () => {
  const report = await run('AGENTFX', { modelRequested: true, chooserError: { code: 'NIGHTSHIFT_NOT_CONFIGURED', message: 'no credentials' } });
  assert.equal(report.phases.exploration.plannerError.code, 'NIGHTSHIFT_NOT_CONFIGURED');
  assert.deepEqual([report.modelParticipation, report.modelParticipationReason, report.status], ['FAILED', 'NIGHTSHIFT_NOT_CONFIGURED', 'DEGRADED_NO_MODEL']);
  assert.ok(report.degradations.some((d: any) => d.code === 'NIGHTSHIFT_NOT_CONFIGURED' && d.detail === 'no credentials'));
  const none = await run('AGENTFX', { modelRequested: true });
  assert.deepEqual([none.modelParticipation, none.status], ['FAILED', 'DEGRADED_NO_MODEL']);
});

test('S1 NOT_REQUESTED: without the flag nothing changes in status and no model degradation appears', async () => {
  const report = await run('AGENTFX');
  assert.deepEqual([report.modelParticipation, report.status, report.modelParticipationReason], ['NOT_REQUESTED', 'COMPLETED', undefined]);
  assert.equal(report.degradations.some((d: any) => d.phase === 'exploration'), false);
});

test('S1 degradations: critic disabled, COMA requested but not configured, assist/judge without model are listed', async () => {
  const report = await run('AGENTFX', { comaRequested: true, criticAssist: true, secondaryJudge: true });
  const found = codes(report);
  for (const code of ['critic:CRITIC_DISABLED', 'coma:COMA_NOT_CONFIGURED', 'exploration:SECONDARY_JUDGE_NO_MODEL']) assert.ok(found.includes(code), `${code} in ${found}`);
});

test('S3 blind run: no configured relations means no probes, the ranking label says not applicable and the run completes', async () => {
  const report = await run('TPCDS');
  assert.equal(report.probeSelection.modelRanking, 'NOT_APPLICABLE_NO_CONFIGURED_PROBES');
  assert.equal(report.status, 'COMPLETED');
  const plain = await run('AGENTFX');
  assert.equal(plain.probeSelection.modelRanking, 'NOT_USED');
});
