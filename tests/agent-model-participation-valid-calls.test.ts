import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** Scripted chooser; its token estimate jumps over any budget from the `blowAt`-th decision on. */
class Elector implements ActionChooser {
  constructor(private readonly script: string[], private readonly blowAt = Infinity) {}
  private step = 0;
  estimateTokens() { return this.step >= this.blowAt ? 10_000_000 : 10; }
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const selected = this.script[Math.min(this.step++, this.script.length - 1)]!;
    return { stage, status: 'PASS', decisionStatus: allowed.includes(selected) ? 'VALID' : 'INVALID', requestedModel: 'scripted', selected, reason: 'scripted', promptHash: 'h', utc: '2026-10-26T00:00:00.000Z', receipt: { totalTokens: 10 } as any };
  }
}
const run = (extra: Record<string, unknown> = {}, wrap?: (client: any) => any) => {
  const cfg = universeConfig('AGENTFX'), fixture = structuredClone(agentFixtures().find(i => i.alias === 'AGENTFX')!);
  const client = fixtureClient(cfg, fixture.tables) as any;
  return runAgent('AGENTFX', 'agent-mp-valid', { client: wrap ? wrap(client) : client, executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false, modelRequested: true, ...extra }) as Promise<any>;
};
const codes = (report: any) => report.degradations.map((d: any) => `${d.phase}:${d.code}`);

test('RC-1 valid choices then the token cap: USED and COMPLETED, the cap is informational', async () => {
  const report = await run({ chooser: new Elector(['READ_CUSTOMER_PROFILE', 'READ_REGION_REFERENCE', 'STOP_EXPLORATION'], 2) });
  assert.equal(report.phases.exploration.calls.filter((c: any) => c.decisionStatus === 'VALID').length, 2);
  assert.equal(report.phases.exploration.plannerError.code, 'TOKEN_BUDGET_WOULD_EXCEED');
  assert.deepEqual([report.modelParticipation, report.modelParticipationReason, report.status], ['USED', undefined, 'COMPLETED']);
  assert.ok(codes(report).includes('exploration:TOKEN_BUDGET_WOULD_EXCEED'));
});

test('RC-1 a valid choice then a read error: USED but COMPLETED_WITH_WARNINGS', async () => {
  let failed = false;
  const report = await run({ chooser: new Elector(['READ_CUSTOMER_PROFILE', 'READ_REGION_REFERENCE', 'STOP_EXPLORATION']) }, client => ({ ...client, runSql: (sql: string, limit?: number) => {
    if (!failed && /region_code\s+IN/i.test(sql)) { failed = true; throw new Error('transport down'); }
    return client.runSql(sql, limit);
  } }));
  assert.ok(failed, 'the injected read error happened');
  assert.ok(report.phases.exploration.calls.length >= 2);
  assert.deepEqual([report.modelParticipation, report.status], ['USED', 'COMPLETED_WITH_WARNINGS']);
  assert.ok(report.degradations.some((d: any) => d.phase === 'exploration'));
});

test('RC-1 no valid decision at all stays FAILED / DEGRADED_NO_MODEL', async () => {
  const none = await run({});
  assert.deepEqual([none.modelParticipation, none.status], ['FAILED', 'DEGRADED_NO_MODEL']);
  const invalid = await run({ chooser: new Elector(['NOT_AN_ACTION']) });
  assert.equal(invalid.phases.exploration.calls.length, 1);
  assert.deepEqual([invalid.modelParticipation, invalid.status], ['FAILED', 'DEGRADED_NO_MODEL']);
});

class Scripted implements ActionChooser {
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    return { stage, status: 'PASS', decisionStatus: 'VALID', requestedModel: 'fixture-script', selected: allowed[0], reason: 'fixture script choice', promptHash: 'fixture', utc: '2026-10-26T00:00:00.000Z' };
  }
}

test('RC-5 the offline fixture chooser is SCRIPTED_OFFLINE, neither NOT_REQUESTED nor USED, and the run completes', async () => {
  const report = await run({ modelRequested: undefined, chooser: new Scripted() });
  assert.ok(report.phases.exploration.calls.length > 0);
  assert.deepEqual([report.modelParticipation, report.status], ['SCRIPTED_OFFLINE', 'COMPLETED']);
});

test('RC-12 / RC-26 memory gets the explicit origin even in a custom directory and the injected clock', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc12-'));
  try {
    const first = await run({ modelRequested: undefined, memory: { dir }, now: () => '2026-10-26T00:00:00.000Z' });
    assert.notEqual(first.memory.status, 'ERROR');
    assert.deepEqual(first.memory.origin, { executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
