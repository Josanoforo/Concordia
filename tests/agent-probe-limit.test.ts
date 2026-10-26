import test from 'node:test';
import assert from 'node:assert/strict';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { runAgent } from '../src/agent/engine.ts';
import { Zetaris } from '../src/clients/zetaris.ts';
import { planLegacyProbe } from '../src/relations/legacy.ts';
import { executeProbe } from '../src/relations/probes.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

const fx = () => structuredClone(agentFixtures().find(item => item.alias === 'AGENTFX')!);
const run = (id: string, probeLimit?: number, log: string[] = []) => runAgent('AGENTFX', id, { client: fixtureClient(universeConfig('AGENTFX'), fx().tables, log) as any, executionMode: 'LOCAL',
  dataOrigin: 'SYNTHETIC', persist: false, critic: false, probeLimit }) as Promise<any>;
const probeSql = (log: string[]) => log.filter(sql => / IN \(/.test(sql) && /LIMIT \d+$/.test(sql));

test('M4-6: with probeLimit 100 the relation probe SQL carries LIMIT 100 and the run records limits.probeLimit / probeLimitSource', async () => {
  const log: string[] = [], report = await run('agent-probe-limit-100', 100, log);
  assert.ok(probeSql(log).length > 0 && probeSql(log).every(sql => /LIMIT 100$/.test(sql)), 'configured relation probes use the override');
  assert.deepEqual([report.limits.probeLimit, report.limits.probeLimitSource], [100, 'flag']);
  assert.match(report.limits.probeLimitAppliesTo, /configured relation probes only/);
  assert.equal(report.status, 'COMPLETED');
});

test('M4-6: without the override everything is as before (manifest limit, 50 at most, source manifest)', async () => {
  const log: string[] = [], report = await run('agent-probe-limit-default', undefined, log), cfg = universeConfig('AGENTFX');
  assert.deepEqual([report.limits.probeLimit, report.limits.probeLimitSource], [cfg.probeLimit, 'manifest']);
  assert.ok(probeSql(log).every(sql => new RegExp(`LIMIT ${cfg.probeLimit}$`).test(sql)));
  const other = await run('agent-probe-limit-default-2');
  assert.deepEqual(other.decisions, report.decisions);
});

test('M4-6: more than 100 or not an integer is PROBE_LIMIT_OUT_OF_RANGE', async () => {
  for (const bad of [101, 0, -1, 2.5, Number.NaN]) await assert.rejects(() => run('agent-probe-limit-bad', bad), /PROBE_LIMIT_OUT_OF_RANGE/);
});

test('M4-6: the 50 guard stays alive on every path when no explicit override travels', async () => {
  const cfg = universeConfig('AGENTFX'), relation = cfg.relations[0], allowlist = Object.fromEntries(Object.entries<any>(cfg.tables).map(([table, spec]) => [`${spec.db}.${table}`, spec.columns.map((c: any) => c.name)]));
  const plan = (limit: number, max?: number) => planLegacyProbe(relation, 'AGENTFX', '1.0', relation.normalization, 1, allowlist, limit, {}, {}, max);
  assert.throws(() => plan(51), /INVALID_PROBE_LIMIT/);
  assert.throws(() => plan(101, 101), /INVALID_PROBE_LIMIT/);
  assert.equal(plan(100, 100).limit, 100);
  const ctx = { runId: 'r', checkedAt: '2026-10-24T00:00:00Z', scope: 's' }, adapter = { adapterId: 'x', read: async () => ({ tuples: [] }) } as any;
  await assert.rejects(() => executeProbe(plan(100, 100), adapter, ctx), /INVALID_PROBE_LIMIT/, 'a 100-row plan needs the explicit executor ceiling');
  await assert.rejects(() => executeProbe(plan(100, 100), adapter, { ...ctx, maxLimit: 101 }), /INVALID_PROBE_LIMIT/);
  const zetaris = new Zetaris({ base: 'http://127.0.0.1:9', key: 'test', org: '1' });
  await assert.rejects(() => zetaris.runSql('SELECT a FROM d.t LIMIT 51', 51), /INVALID_SQL_LIMIT/);
  await assert.rejects(() => zetaris.runSql('SELECT a FROM d.t LIMIT 100', 100), /INVALID_SQL_LIMIT/);
  await assert.rejects(() => zetaris.runSql('SELECT a FROM d.t LIMIT 101', 101, { limitCeiling: 101 }), /INVALID_SQL_LIMIT/);
  await assert.rejects(() => zetaris.runSql('SELECT a FROM d.t LIMIT 100', 100, { limitCeiling: 100 }), (error: any) => !/INVALID_SQL_LIMIT/.test(String(error?.message ?? error)), 'with the explicit ceiling it passes the limit guard');
});
