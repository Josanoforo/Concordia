import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** P4: the synthetic TPC-DS-shaped fixture drives the whole loop offline. */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted offline choice', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const fixture = () => agentFixtures().find(item => item.alias === 'TPCDS')!;

test('P4: the synthetic fixture covers the 24 tables with exactly the configured columns, few rows and every key column non-null', () => {
  const cfg = universeConfig('TPCDS'), tables = fixture().tables;
  assert.deepEqual(Object.keys(tables).sort(), Object.keys(cfg.tables).sort());
  for (const [id, table] of Object.entries(tables)) {
    assert.deepEqual(table.columns.map(column => column.name), cfg.tables[id].columns.map((column: any) => column.name), id);
    assert.ok(table.rows.length >= 5 && table.rows.length <= 6, id);
    assert.ok(table.rows.every(row => row.length === table.columns.length && row.every(cell => cell !== null && cell !== undefined)), id);
  }
  assert.deepEqual(fixture().adjudications, {}); assert.match(fixture().basis, /SYNTHETIC_FIXTURE/);
});

test('P4: the whole loop runs offline on the TPCDS fixture: 24 tables discovered, bounded self-keyed reads, no probes and no verdict without configured relations', async () => {
  const cfg = universeConfig('TPCDS'), log: string[] = [];
  const report: any = await runAgent('TPCDS', 'agent-tpcds-offline-1', { client: fixtureClient(cfg, fixture().tables, log) as any, chooser: new Script([...fixture().chooserScript]), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: true });
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.phases.discovery.tables.length, 24); assert.deepEqual(report.phases.discovery.relations, []);
  assert.deepEqual(report.phases.exploration.actions.filter((item: any) => item.execution === 'PASS').map((item: any) => item.action), ['READ_CUSTOMER_KEYS', 'PROFILE_C_CUSTOMER_SK', 'PROFILE_SS_CUSTOMER_SK']);
  const profiles = report.phases.exploration.actions.filter((item: any) => item.action.startsWith('PROFILE_'));
  assert.deepEqual(profiles.map((item: any) => item.observation.summary ?? item.observation), profiles.map((item: any) => item.observation.summary ?? item.observation));
  const read = report.phases.exploration.reads.PROFILE_C_CUSTOMER_SK;
  assert.ok(read && read.rows === 1, 'the profile returns one aggregate row, never a key value');
  assert.deepEqual(report.phases.probes.selected, []); assert.deepEqual(report.decisions, []);
  assert.ok(report.budget.used.queries <= 100 && report.budget.used.steps <= 3);
  assert.ok(log.every(sql => /^SELECT /.test(sql) && /LIMIT \d+/.test(sql) && !/\b(JOIN|GROUP\s+BY|ORDER\s+BY)\b/i.test(sql) && (!/COUNT/i.test(sql) || /concordia_bounded$/.test(sql))), 'every read is bounded and join-free; COUNT only inside the bounded profile template');
});
