import test from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { offlineAgentDeps } from '../src/agent/offline-deps.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** E1-06 wiring: one profile cache per run shared by post-COMA, tie evidence and full evidence; a target referenced by N candidates is scanned once per run. */
class Script implements ActionChooser {
  constructor(private readonly script: string[]) {}
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const next = this.script.shift() ?? 'STOP_EXPLORATION', ok = allowed.includes(next);
    return { stage, status: 'PASS', decisionStatus: ok ? 'VALID' : 'INVALID_RESPONSE', requestedModel: 'scripted', selected: ok ? next : undefined, reason: 'scripted', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const fixture = () => structuredClone(agentFixtures().find(item => item.alias === 'NWCH')!);
const profileOf = (f: any, table: string, column: string) => {
  const t = f.tables[table], index = t.columns.findIndex((c: any) => c.name === column), values = t.rows.map((row: unknown[]) => row[index]), present = values.filter((v: unknown) => v !== null && v !== undefined);
  return [values.length, new Set(present).size, values.length - present.length];
};

test('a column referenced by several candidates is profiled once per run (post-COMA, tie evidence and full evidence share the cache)', async () => {
  const f = fixture(), base = offlineAgentDeps('NWCH', f, new Script([...f.chooserScript])), cfg = universeConfig('NWCH');
  const physical = Object.fromEntries(Object.entries<any>(cfg.tables).map(([name, spec]) => [spec.physicalTable, name]));
  const scans = new Map<string, number>();
  const client = { ...base.client, runSql: async (sql: string, limit?: number) => {
    const whole = /^SELECT COUNT\(\*\) AS concordia_rows, COUNT\(DISTINCT `?(\w+)`?\) AS concordia_distinct, SUM\(CASE WHEN `?\w+`? IS NULL THEN 1 ELSE 0 END\) AS concordia_nulls FROM (.+)$/i.exec(sql);
    if (!whole || /LIMIT \d+\) concordia_bounded$/i.test(sql)) return (base.client as any).runSql(sql, limit);
    const table = Object.keys(physical).map(name => physical[name]!).find(name => whole[2]!.includes(cfg.tables[name].physicalTable))!, key = `${table}.${whole[1]}`;
    scans.set(key, (scans.get(key) ?? 0) + 1);
    return { sql, rows: [profileOf(f, table, whole[1]!)], requestId: 'fx-f1', queryId: 'fx-f1', durationMs: 0, utc: 'x' };
  } };
  const report: any = await runAgent('NWCH', 'agent-profile-cache-1', { ...base, client: client as any, persist: false, critic: false, candidateReview: async request => ({ overlay: { origin: 'MODEL_REVIEW', counts: { approved: 0 }, notApproved: [] }, contracts: [] }) });
  assert.ok(scans.size > 0, 'whole-table profiles were requested');
  for (const [key, count] of scans) assert.equal(count, 1, `${key} scanned ${count} times in one run`);
  const tie = report.phases.candidateReview.tieEvidence;
  assert.equal(tie.queries + tie.cached.length, tie.targets.length, 'every tie target was either scanned or served from the cache');
});
