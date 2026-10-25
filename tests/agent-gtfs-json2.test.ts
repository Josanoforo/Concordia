import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readJson } from '../src/runtime.ts';
import { loadSvp1Profiles } from '../src/svp1.ts';
import { canonicalJson2SchemaSha256, canonicalJson2TypedMultisetSha256, type Json2LiveBindingDocument } from '../src/relations/adapters/zetaris-json2.ts';
import { agentFixtures } from '../src/eval/agent-eval.ts';
import { fixtureClient } from '../src/eval/fixture-client.ts';
import { guardJson2Client } from '../src/agent/json2-guard.ts';
import { liveClientFor } from '../src/agent/cli-run.ts';
import { runAgent } from '../src/agent/engine.ts';
import type { ActionChooser, ChoiceCall } from '../src/agent/chooser.ts';
import { renderAgentRunMarkdown } from '../src/report/agent-run-report.ts';
import { resolveUniverseManifest, validateUniverseConfig, validateUniverseRegistry, universeManifests } from '../src/registry/universes.ts';
import { universeConfig } from '../src/universe-pipeline.ts';

/** GTFSAGENT: the JSON2 GTFS tables in the generic loop, behind a client guard that restores the binding rules. */
class Script implements ActionChooser {
  async choose(stage: string, _o: unknown, allowed: readonly string[]): Promise<ChoiceCall> {
    const selected = allowed.includes('READ_ROUTE_REFERENCE') ? 'READ_ROUTE_REFERENCE' : 'STOP_EXPLORATION';
    return { stage, status: 'PASS', decisionStatus: 'VALID', requestedModel: 'scripted', selected, reason: 'scripted offline choice', promptHash: 'x', utc: '2026-10-24T00:00:00.000Z' };
  }
}
const fixture = () => agentFixtures().find(item => item.alias === 'GTFSAGENT')!;
const DB = 'CONCORDIA_L2_SOURCES_20261023_SVP1_JSON2';
/** The real binding restricted to the two GTFS tables, with receipts recomputed from the fixture rows (the fixture is the pinned synthetic snapshot). */
function offlineBinding() {
  const binding = readJson<Json2LiveBindingDocument>('universes/svp1-live-bindings.json'), cfg = universeConfig('GTFSAGENT'), tables = fixture().tables;
  const bound = binding.tables.filter(item => ['gtfs_trips', 'gtfs_routes'].includes(item.physicalTable)).map(item => {
    const id = item.physicalTable === 'gtfs_trips' ? 'trips' : 'routes', rows = tables[id].rows;
    return { ...item, expectedRows: rows.length, observedSchemaSha256: canonicalJson2SchemaSha256(item.columns.map(c => [c.name, c.kind])), typedMultisetSha256: canonicalJson2TypedMultisetSha256(rows, item.columns) };
  });
  return { cfg, binding: { ...binding, tables: bound } as Json2LiveBindingDocument };
}

test('GTFSAGENT is registered as an AGENT_EXPLORATION universe over the JSON2 tables with the human review recorded; svp1_G01/G02 are untouched', () => {
  const manifest = resolveUniverseManifest('GTFSAGENT')!, cfg = universeConfig('GTFSAGENT');
  assert.deepEqual(validateUniverseRegistry(universeManifests), []); assert.deepEqual(validateUniverseConfig(manifest, cfg), []);
  assert.equal(manifest.source.adapterId, 'zetaris'); assert.equal(manifest.source.dataOrigin, 'SYNTHETIC');
  const relation = cfg.relations[0];
  assert.deepEqual([relation.kind, relation.reviewState, relation.normalizationVersion, relation.normalizationLossless, relation.normalizationAdapterCapability], ['FOREIGN_KEY', 'REVIEWED', 'svp1-exact-native-v1', true, 'exact-text']);
  assert.deepEqual([relation.reviewAuthorization.approver, relation.reviewAuthorization.approvedAt], ['project-owner', '2026-10-25']);
  assert.match(relation.reviewAuthorization.quote, /svp1_G01/);
  const profile = loadSvp1Profiles().find(item => item.manifestId === 'concordia.universe.gtfs-svp1')!;
  assert.ok(profile.relations.every(item => item.reviewState === 'PENDING'), 'the SVP1 profile contracts are not modified');
  assert.equal(manifest.relationIds.length, 1);
});

test('the guarded client runs the whole generic loop offline: preflight first, every emitted SQL shape accepted, SOSTENIDA', async () => {
  const { cfg, binding } = offlineBinding(), log: string[] = [];
  const guarded = guardJson2Client(cfg, fixtureClient(cfg, fixture().tables, log) as any, binding);
  const report: any = await runAgent('GTFSAGENT', 'agent-gtfsagent-guard-1', { client: guarded as any, chooser: new Script(), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: true });
  assert.equal(report.status, 'COMPLETED');
  assert.equal(report.phases.exploration.actions[0].action, 'READ_ROUTE_REFERENCE');
  assert.deepEqual(report.decisions.map((d: any) => [d.relationId, d.verdict]), [['gtfsagent_trip_route', 'SOSTENIDA']]);
  assert.equal(report.phases.critic.status, 'EVALUATED'); assert.equal(report.phases.critic.summary.errors, 0);
  assert.equal((guarded as any).preflightSummary().status, 'COMPLETE');
  assert.ok(log.length > 0 && log.every(sql => /^SELECT /.test(sql) && /LIMIT \d+/.test(sql) && !/\*/.test(sql)));
});

test('the guard refuses reads when the fresh binding check is not COMPLETE, and rejects anything outside the binding', async () => {
  const { cfg, binding } = offlineBinding();
  const changed = structuredClone(fixture().tables); changed.trips.rows[0][1] = 'ZZ';
  const stale = guardJson2Client(cfg, fixtureClient(cfg, changed, []) as any, binding);
  await assert.rejects(() => stale.runSql(`SELECT route_id FROM ${DB}.gtfs_routes LIMIT 5`, 5), /JSON2_GUARD_PREFLIGHT_INCOMPLETE/);
  const inner = fixtureClient(cfg, fixture().tables, []), guarded = guardJson2Client(cfg, inner as any, binding);
  await assert.rejects(() => guarded.runSql(`SELECT * FROM ${DB}.gtfs_trips LIMIT 5`, 5), /JSON2_GUARD_SQL_REJECTED/);
  await assert.rejects(() => guarded.runSql(`SELECT stop_id FROM ${DB}.gtfs_trips LIMIT 5`, 5), /JSON2_GUARD_COLUMN_OUTSIDE_BINDING/);
  await assert.rejects(() => guarded.runSql(`SELECT trip_id FROM ${DB}.gtfs_stop_times LIMIT 5`, 5), /JSON2_GUARD_TABLE_OUTSIDE_BINDING/);
  await assert.rejects(() => guarded.runSql(`SELECT trip_id FROM ${DB}.gtfs_trips LIMIT 51`, 51), /JSON2_GUARD_LIMIT_OUTSIDE_BINDING/);
  await assert.rejects(() => guarded.runSql(`SELECT a.trip_id FROM ${DB}.gtfs_trips a JOIN ${DB}.gtfs_routes b ON a.route_id = b.route_id LIMIT 5`, 5), /JSON2_GUARD_SQL_REJECTED/);
  await assert.rejects(() => guarded.describe(DB, 'gtfs_stop_times'), /JSON2_GUARD_TABLE_OUTSIDE_BINDING/);
  const rows = fixture().tables.trips.rows, many = Array.from({ length: 21 }, () => rows[0]);
  const wide = guardJson2Client(cfg, { describe: inner.describe, runSql: async (sql: string, limit?: number) => { const r = await inner.runSql(sql, limit); return /gtfs_trips/.test(sql) && /WHERE/.test(sql) ? { ...r, rows: many } : r; } } as any, binding);
  await assert.rejects(() => wide.runSql(`SELECT trip_id, route_id FROM ${DB}.gtfs_trips WHERE route_id IN ('AB') LIMIT 50`, 50), /JSON2_GUARD_ROWS_EXCEED_BINDING/);
});

test('the CLI picks the guarded client only for universes that declare a live binding', t => {
  const saved = { ...process.env };
  Object.assign(process.env, { ZETARIS_REST_URL: 'http://127.0.0.1:1', ZETARIS_API_KEY: 'test-key', ZETARIS_ORG_ID: '1' });
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  assert.equal(typeof (liveClientFor('GTFSAGENT') as any).preflightSummary, 'function');
  assert.equal(typeof (liveClientFor('AGENTFX') as any).preflightSummary, 'undefined');
});

test('two passes with memory: SOSTENIDA writes the claim, the second pass is REUSED in the LOCAL-SYNTHETIC store and the report shows it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtfsagent-memory-'));
  try {
    const run = (id: string) => runAgent('GTFSAGENT', id, { client: fixtureClient(universeConfig('GTFSAGENT'), fixture().tables) as any, chooser: new Script(), executionMode: 'LOCAL', dataOrigin: 'SYNTHETIC', persist: false, critic: false, memory: { dir } }) as Promise<any>;
    const first = await run('agent-gtfsagent-mem-1'), second = await run('agent-gtfsagent-mem-2');
    assert.equal(first.decisions[0].verdict, 'SOSTENIDA'); assert.deepEqual(first.decisions[0].reasonCodes, ['bounded_sample_key_membership']);
    assert.equal(first.memory.status, 'RECORDED'); assert.ok(first.memory.claims.some((claim: any) => claim.relationId === 'gtfsagent_trip_route' && claim.firstRunId === 'agent-gtfsagent-mem-1'));
    assert.equal(first.memory.reuse.mode, 'COLD');
    assert.equal(second.decisions[0].verdict, 'SOSTENIDA'); assert.deepEqual(second.decisions[0].reasonCodes, ['REUSED_FROM_MEMORY']);
    assert.equal(second.decisions[0].reused.fromRunId, 'agent-gtfsagent-mem-1');
    assert.deepEqual(second.phases.probes.selected, [], 'a reused relation is not probed again');
    assert.ok(second.memory.reuse.reused.some((item: any) => item.relationId === 'gtfsagent_trip_route' && item.queriesSaved > 0));
    assert.match(renderAgentRunMarkdown(second), /REUSED/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
